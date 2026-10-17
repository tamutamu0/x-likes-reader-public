import Foundation
import MarginCore

// Executable integration probe, not the iOS app's interface.
@main struct MarginSmoke {
    static func main() async throws {
        let client = try APIClient(baseURL: URL(string: "http://127.0.0.1:8787")!, localDevelopment: true)
        let cache = try ReaderCache()
        let engine = SyncEngine(client: client, cache: cache)
        try await engine.pull()
        let before = await cache.snapshot()
        guard let item = before.items.values.sorted(by: { $0.id < $1.id }).first,
              item.metadata.fictional else { throw ClientError.invalidResponse }
        try await cache.stage(id: item.id, changes: UserChanges(read: true, memo: "SwiftとWorkersの接続確認（架空データ）"))
        try await engine.flush()
        try await engine.pull()
        let after = await cache.snapshot()
        guard after.items[item.id]?.user.read == true, after.pending.isEmpty else { throw ClientError.invalidResponse }
        do {
            _ = try await client.patch(id: item.id, expectedRevision: item.revision, changes: UserChanges(memo: "上書きしてはいけない"))
            throw ClientError.invalidResponse
        } catch ClientError.conflict { }
        print("PASS: Swift client → Workers/D1; \(after.items.count) fictional items; edit, incremental sync, conflict")
    }
}
