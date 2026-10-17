import Foundation
import Observation
import MarginCore

@MainActor @Observable final class ReaderModel {
    var snapshot = CacheSnapshot()
    var isLoading = false
    var message: String?
    var isDemo = true
    private var cache: ReaderCache?
    private var engine: SyncEngine?

    var items: [ReaderItem] { snapshot.items.values.sorted { $0.id > $1.id } }
    func displayed(_ item: ReaderItem) -> ReaderItem {
        var result = item
        if let pending = snapshot.pending[item.id] { result.user = pending.changes.applying(to: item.user) }
        return result
    }
    func start() async {
        guard engine == nil, !isLoading else { return }
        isLoading = true; defer { isLoading = false }
        do {
            #if SWIFT_PACKAGE
            let bundle = Bundle.module
            #else
            let bundle = Bundle.main
            #endif
            guard let url = bundle.url(forResource: "items", withExtension: "json") else { throw ClientError.invalidConfiguration }
            let fixture = try JSONDecoder().decode(ItemPage.self, from: Data(contentsOf: url))
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let file = directory.appendingPathComponent("margin/demo-cache.json")
            let cache = try ReaderCache(file: file)
            let saved = await cache.snapshot()
            var client: APIClient
            #if DEBUG
            if let origin = ProcessInfo.processInfo.environment["MARGIN_API_ORIGIN"] {
                guard let url = URL(string: origin) else { throw ClientError.invalidConfiguration }
                client = try APIClient(baseURL: url, localDevelopment: true)
                isDemo = false
            } else {
                client = try APIClient(baseURL: URL(string: "https://demo.margin.invalid")!, transport: DemoTransport(items: saved.items.isEmpty ? fixture.items : Array(saved.items.values), startCursor: saved.cursor))
            }
            #else
            client = try APIClient(baseURL: URL(string: "https://demo.margin.invalid")!, transport: DemoTransport(items: saved.items.isEmpty ? fixture.items : Array(saved.items.values), startCursor: saved.cursor))
            #endif
            // Live-development cache is isolated from the persistent offline demo.
            let activeCache = isDemo ? cache : try ReaderCache()
            self.cache = activeCache
            self.engine = SyncEngine(client: client, cache: activeCache)
            try await engine!.pull()
            snapshot = await activeCache.snapshot()
        } catch { message = "起動できませんでした。設定と保存先を確認してください。" }
    }
    func refresh() async {
        guard let engine, let cache, !isLoading else { return }
        isLoading = true; defer { isLoading = false }
        do {
            try await engine.flush(); try await engine.pull()
            snapshot = await cache.snapshot()
        } catch { snapshot = await cache.snapshot(); message = "同期できませんでした。保存中のメモは端末に残っています。" }
    }
    @discardableResult
    func update(id: String, changes: UserChanges, resolvingConflict: Bool = false) async -> Bool {
        guard let cache, let engine else { return false }
        do {
            try await cache.stage(id: id, changes: changes, resolvingConflict: resolvingConflict)
            snapshot = await cache.snapshot() // Optimistic display after durable staging.
            try await engine.flush()
            snapshot = await cache.snapshot()
            if snapshot.pending[id]?.hasConflict == true {
                message = "別の端末で更新されています。下書きを確認してください。"
                return false
            }
            if snapshot.pending[id] != nil {
                message = "変更は端末に保存済みです。同期の完了を待ってから更新してください。"
                return false
            }
            message = nil
            return true
        } catch { snapshot = await cache.snapshot(); message = "保存を完了できませんでした。この画面のメモは閉じずに確認してください。"; return false }
    }
    func discardDraft(id: String) async {
        guard let cache else { return }
        do { try await cache.discardDraft(id: id); snapshot = await cache.snapshot() }
        catch { message = "下書きを変更できませんでした。" }
    }
}
