import Foundation

public struct PendingEdit: Codable, Equatable, Sendable {
    public var expectedRevision: Int
    public var changes: UserChanges
    public var hasConflict: Bool
}
public struct CacheSnapshot: Codable, Sendable {
    public var cursor: Int = 0
    public var items: [String: ReaderItem] = [:]
    public var pending: [String: PendingEdit] = [:]
    public init() {}
}
// UI-independent synchronization core; SwiftData presentation cache is a later
// layer. Applying a page and advancing its cursor is one atomic file write.
public actor ReaderCache {
    private var state: CacheSnapshot
    private let file: URL?
    public init(file: URL? = nil) throws {
        self.file = file
        if let file, FileManager.default.fileExists(atPath: file.path) {
            state = try JSONDecoder().decode(CacheSnapshot.self, from: Data(contentsOf: file))
        } else { state = CacheSnapshot() }
    }
    public func snapshot() -> CacheSnapshot { state }
    private func commit(_ next: CacheSnapshot) throws {
        if let file {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(next).write(to: file, options: [.atomic, .completeFileProtection])
        }
        state = next
    }
    public func apply(_ page: ChangePage) throws {
        guard page.nextCursor >= state.cursor,
              page.changes.allSatisfy({ $0.cursor > state.cursor && $0.cursor <= page.nextCursor }),
              zip(page.changes, page.changes.dropFirst()).allSatisfy({ $0.cursor < $1.cursor }),
              !page.hasMore || !page.changes.isEmpty else { throw ClientError.invalidResponse }
        var next = state
        for change in page.changes {
            if let old = next.items[change.item.id], old.revision > change.item.revision { continue }
            next.items[change.item.id] = change.item
            if let edit = next.pending[change.item.id], edit.expectedRevision != change.item.revision {
                next.pending[change.item.id]?.hasConflict = true
            }
        }
        next.cursor = page.nextCursor
        try commit(next)
    }
    public func stage(id: String, changes: UserChanges, resolvingConflict: Bool = false) throws {
        guard let item = state.items[id] else { throw ClientError.missingItem }
        guard !changes.isEmpty else { throw ClientError.invalidResponse }
        let previous = state.pending[id]
        if previous?.hasConflict == true && !resolvingConflict { throw ClientError.conflict(item) }
        var next = state
        next.pending[id] = PendingEdit(
            expectedRevision: resolvingConflict ? item.revision : (previous?.expectedRevision ?? item.revision),
            changes: previous?.changes.merging(changes) ?? changes, hasConflict: false
        )
        try commit(next)
    }
    public func accept(_ item: ReaderItem, edit: PendingEdit) throws {
        var next = state
        if next.items[item.id]?.revision ?? 0 <= item.revision { next.items[item.id] = item }
        if next.pending[item.id] == edit { next.pending.removeValue(forKey: item.id) }
        try commit(next)
    }
    public func conflict(_ item: ReaderItem) throws {
        var next = state
        next.items[item.id] = item
        next.pending[item.id]?.hasConflict = true
        try commit(next)
    }
    public func discardDraft(id: String) throws {
        var next = state; next.pending.removeValue(forKey: id); try commit(next)
    }
}

public actor SyncEngine {
    public let cache: ReaderCache
    private let client: APIClient
    private var running = false
    public init(client: APIClient, cache: ReaderCache) { self.client = client; self.cache = cache }
    public func pull() async throws {
        guard !running else { return }
        running = true; defer { running = false }
        for _ in 0..<100 {
            let cursor = await cache.snapshot().cursor
            let page = try await client.changes(after: cursor)
            try await cache.apply(page)
            if !page.hasMore { return }
        }
        throw ClientError.tooManyPages
    }
    public func flush() async throws {
        guard !running else { return }
        running = true; defer { running = false }
        let pending = await cache.snapshot().pending
        for id in pending.keys.sorted() {
            guard let edit = pending[id], !edit.hasConflict else { continue }
            do {
                let item = try await client.patch(id: id, expectedRevision: edit.expectedRevision, changes: edit.changes)
                try await cache.accept(item, edit: edit)
            } catch ClientError.conflict(let item) {
                try await cache.conflict(item)
            }
            // Other errors propagate and retain the draft; no automatic retry storm.
        }
    }
}
