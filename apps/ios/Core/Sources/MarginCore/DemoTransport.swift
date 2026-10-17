import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Offline fictional transport. No URLSession, X calls, cookies, or credentials.
public actor DemoTransport: HTTPTransport {
    private var items: [String: ReaderItem]
    private var log: [Change] = []
    private var cursor: Int
    public init(items: [ReaderItem], startCursor: Int = 0) {
        precondition(items.allSatisfy { $0.metadata.fictional })
        self.items = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        self.cursor = startCursor
        for item in items.sorted(by: { $0.id < $1.id }) {
            self.cursor += 1; self.log.append(Change(cursor: self.cursor, item: item))
        }
    }
    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        guard let url = request.url, url.host == "demo.margin.invalid" else { throw ClientError.invalidConfiguration }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func parameter(_ name: String) -> String? { query.first { $0.name == name }?.value }
        let encoder = JSONEncoder()
        if url.path == "/v1/changes" {
            let after = Int(parameter("after") ?? "0") ?? 0
            let limit = max(1, min(100, Int(parameter("limit") ?? "50") ?? 50))
            let remaining = log.filter { $0.cursor > after }
            let changes = Array(remaining.prefix(limit))
            return (try encoder.encode(ChangePage(changes: changes, nextCursor: changes.last?.cursor ?? after, hasMore: remaining.count > limit)), 200)
        }
        if url.path == "/v1/items" { return (try encoder.encode(ItemPage(items: items.values.sorted { $0.id < $1.id }, nextCursor: nil)), 200) }
        let id = String(url.path.dropFirst("/v1/items/".count))
        guard var item = items[id] else { return (Data("{\"error\":{\"code\":\"not_found\",\"message\":\"投稿が見つかりません\"}}".utf8), 404) }
        if request.httpMethod == "PATCH" {
            let patch = try JSONDecoder().decode(PatchRequest.self, from: request.httpBody ?? Data())
            guard patch.expectedRevision == item.revision else {
                return (try encoder.encode(ConflictEnvelope(error: APIProblem(code: "conflict", message: "更新されています"), item: item)), 409)
            }
            item.user = patch.changes.applying(to: item.user)
            item.revision += 1; item.updatedAt = ISO8601DateFormatter().string(from: Date())
            items[id] = item; cursor += 1; log.append(Change(cursor: cursor, item: item))
        }
        return (try encoder.encode(item), 200)
    }
}
