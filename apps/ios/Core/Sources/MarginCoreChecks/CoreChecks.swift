import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import MarginCore

private func fixture() throws -> ItemPage {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    return try JSONDecoder().decode(ItemPage.self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/items.json")))
}
private func page(_ items: [ReaderItem], from cursor: Int = 1, hasMore: Bool = false) throws -> ChangePage {
    let changes = items.enumerated().map { Change(cursor: cursor + $0.offset, item: $0.element) }
    return ChangePage(changes: changes, nextCursor: changes.last?.cursor ?? cursor, hasMore: hasMore)
}
private actor MockTransport: HTTPTransport {
    private var responses: [(Data, Int)]
    private var captured: [URLRequest] = []
    init(_ responses: [(Data, Int)]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        captured.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
    func requests() -> [URLRequest] { captured }
}

@MainActor struct CoreChecks {
    func testSharedContractFixtureAndLargeIDPrecision() throws {
        let data = try fixture()
        try equal(data.items[0].source?.postId, "8000000000000000001")
        try expect(data.items.allSatisfy { $0.metadata.fictional })
        let decoded = try JSONDecoder().decode(ItemPage.self, from: JSONEncoder().encode(data))
        try equal(decoded.items, data.items)
    }

    func testProductionRejectsHTTPAndDevelopmentRejectsRemoteHosts() throws {
        try expectThrows(try APIClient(baseURL: URL(string: "http://example.com")!))
        try expectThrows(try APIClient(baseURL: URL(string: "https://example.com")!, localDevelopment: true))
        try expectThrows(try APIClient(baseURL: URL(string: "https://user:password@example.com")!))
        _ = try APIClient(baseURL: URL(string: "http://127.0.0.1:8787")!, localDevelopment: true)
        _ = try APIClient(baseURL: URL(string: "https://example.com")!)
    }

    func testExplicitNullAndOmittedChangesRemainDistinct() throws {
        let changes = UserChanges(read: true, laterUntil: .null, genre: .null)
        let object = try require(JSONSerialization.jsonObject(with: JSONEncoder().encode(changes)) as? [String: Any])
        try expect(object["laterUntil"] is NSNull)
        try expect(object["genre"] is NSNull)
        try expectNil(object["memo"])
        let restored = try JSONDecoder().decode(UserChanges.self, from: JSONEncoder().encode(changes))
        try equal(restored.laterUntil, .null)
        try equal(restored.genre, .null)
        try expectNil(restored.memo)
        let user = changes.applying(to: try fixture().items[0].user)
        try expect(user.read); try expectNil(user.laterUntil)
    }

    func testRequestHeadersAndPathAreCorrect() async throws {
        let transport = MockTransport([(try JSONEncoder().encode(fixture()), 200)])
        let client = try APIClient(baseURL: URL(string: "http://127.0.0.1:8787")!, localDevelopment: true, transport: transport)
        _ = try await client.items(limit: 1)
        let requests = await transport.requests()
        try equal(requests[0].value(forHTTPHeaderField: "X-Margin-Request"), "1")
        try expectNil(requests[0].value(forHTTPHeaderField: "Authorization"))
        try equal(requests[0].url?.path, "/v1/items")
        try equal(requests[0].url?.query, "limit=1")
        do { _ = try await client.item(id: "../secret"); throw CheckFailure("Bad ID was accepted") }
        catch ClientError.invalidItemID { }
    }

    func testOfflineDraftSurvivesRestartAndRemoteContentRemoval() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("cache.json")
        let cache = try ReaderCache(file: file)
        var item = try fixture().items[0]
        try await cache.apply(page([item]))
        try await cache.stage(id: item.id, changes: UserChanges(memo: "保存前の自分の下書き"))
        item.revision += 1; item.source = nil; item.metadata.sourceStatus = .removed
        try await cache.apply(page([item], from: 2))
        let reopened = try ReaderCache(file: file)
        let snapshot = await reopened.snapshot()
        try expectNil(snapshot.items[item.id]?.source)
        try equal(snapshot.pending[item.id]?.changes.memo, "保存前の自分の下書き")
        try equal(snapshot.pending[item.id]?.hasConflict, true)
        try equal(snapshot.cursor, 2)
        try expectFalse(try String(contentsOf: file, encoding: .utf8).contains("これは開発確認用"))
    }

    func testOutOfOrderChangesDoNotAdvanceCursorOrModifyCache() async throws {
        let cache = try ReaderCache(); let item = try fixture().items[0]
        try await cache.apply(page([item], from: 2))
        do { try await cache.apply(page([item], from: 1)); throw CheckFailure("Old cursor was accepted") }
        catch ClientError.invalidResponse { }
        let snapshot = await cache.snapshot(); try equal(snapshot.cursor, 2)
    }

    func testNetworkFailureKeepsPendingEditWithoutRetryStorm() async throws {
        let cache = try ReaderCache(); let item = try fixture().items[0]
        try await cache.apply(page([item]))
        try await cache.stage(id: item.id, changes: UserChanges(memo: "オフラインのメモ"))
        let transport = MockTransport([])
        let client = try APIClient(baseURL: URL(string: "https://example.com")!, transport: transport)
        let engine = SyncEngine(client: client, cache: cache)
        var failed = false
        do { try await engine.flush() } catch { failed = true }
        try expect(failed)
        let snapshot = await cache.snapshot()
        try equal(snapshot.pending[item.id]?.changes.memo, "オフラインのメモ")
        let calls = await transport.requests(); try equal(calls.count, 1)
    }

    func testConflictKeepsDraftAndLatestServerItem() async throws {
        let cache = try ReaderCache(); var item = try fixture().items[0]
        try await cache.apply(page([item]))
        try await cache.stage(id: item.id, changes: UserChanges(memo: "iPhoneの下書き"))
        item.revision = 2; item.user.memo = "PCの保存済みメモ"
        let response = ConflictEnvelope(error: APIProblem(code: "conflict", message: "更新競合"), item: item)
        let transport = MockTransport([(try JSONEncoder().encode(response), 409)])
        let client = try APIClient(baseURL: URL(string: "https://example.com")!, transport: transport)
        let engine = SyncEngine(client: client, cache: cache)
        try await engine.flush()
        let snapshot = await cache.snapshot()
        try equal(snapshot.items[item.id]?.user.memo, "PCの保存済みメモ")
        try equal(snapshot.pending[item.id]?.changes.memo, "iPhoneの下書き")
        try equal(snapshot.pending[item.id]?.hasConflict, true)
        try await engine.flush(); let calls = await transport.requests(); try equal(calls.count, 1)
    }

    func testMergingDraftAndExplicitConflictResolutionPreserveOtherFields() async throws {
        let cache = try ReaderCache(); var item = try fixture().items[0]
        try await cache.apply(page([item]))
        try await cache.stage(id: item.id, changes: UserChanges(read: true, tags: ["自分のタグ"]))
        try await cache.stage(id: item.id, changes: UserChanges(memo: "新しいメモ"))
        var state = await cache.snapshot()
        try equal(state.pending[item.id]?.changes.read, true)
        try equal(state.pending[item.id]?.changes.memo, "新しいメモ")
        item.revision += 1; item.user.memo = "PCの更新"
        try await cache.conflict(item)
        do { try await cache.stage(id: item.id, changes: UserChanges(memo: "黙って上書き")); throw CheckFailure("Conflict was overwritten") }
        catch ClientError.conflict { }
        try await cache.stage(id: item.id, changes: UserChanges(memo: "本人が確認したメモ"), resolvingConflict: true)
        state = await cache.snapshot()
        try equal(state.pending[item.id]?.expectedRevision, item.revision)
        try equal(state.pending[item.id]?.changes.tags, ["自分のタグ"])
        try equal(state.pending[item.id]?.hasConflict, false)
    }

    func testFailedPersistenceDoesNotAdvanceStateOrCursor() async throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("a file, not a directory".utf8).write(to: parent)
        defer { try? FileManager.default.removeItem(at: parent) }
        let cache = try ReaderCache(file: parent.appendingPathComponent("cache.json"))
        var failed = false
        do { try await cache.apply(page(fixture().items)) } catch { failed = true }
        try expect(failed)
        let state = await cache.snapshot()
        try equal(state.cursor, 0); try expect(state.items.isEmpty)
    }

    func testOfflineDemoUsesSameClientAndPreservesEditsAcrossRefresh() async throws {
        let transport = DemoTransport(items: try fixture().items)
        let client = try APIClient(baseURL: URL(string: "https://demo.margin.invalid")!, transport: transport)
        let cache = try ReaderCache(); let engine = SyncEngine(client: client, cache: cache)
        try await engine.pull()
        let item = try require(await cache.snapshot().items.values.first)
        try await cache.stage(id: item.id, changes: UserChanges(read: true, memo: "画面からの編集"))
        try await engine.flush(); try await engine.pull()
        let state = await cache.snapshot()
        try expect(state.pending.isEmpty)
        try equal(state.items[item.id]?.user.memo, "画面からの編集")
        try equal(state.items[item.id]?.user.read, true)
    }
}

private struct CheckFailure: Error { let message: String; init(_ message: String) { self.message = message } }
private func expect(_ value: Bool) throws { if !value { throw CheckFailure("Expected true") } }
private func expectFalse(_ value: Bool) throws { try expect(!value) }
private func equal<T: Equatable>(_ value: T, _ expected: T) throws { if value != expected { throw CheckFailure("Values differ") } }
private func expectNil<T>(_ value: T?) throws { if value != nil { throw CheckFailure("Expected nil") } }
private func require<T>(_ value: T?) throws -> T { guard let value else { throw CheckFailure("Expected value") }; return value }
private func expectThrows<T>(_ value: @autoclosure () throws -> T) throws {
    do { _ = try value() } catch { return }
    throw CheckFailure("Expected an error")
}
@main struct MarginCoreChecks {
    @MainActor static func main() async throws {
        let tests = CoreChecks()
        try tests.testSharedContractFixtureAndLargeIDPrecision()
        try tests.testProductionRejectsHTTPAndDevelopmentRejectsRemoteHosts()
        try tests.testExplicitNullAndOmittedChangesRemainDistinct()
        try await tests.testRequestHeadersAndPathAreCorrect()
        try await tests.testOfflineDraftSurvivesRestartAndRemoteContentRemoval()
        try await tests.testOutOfOrderChangesDoNotAdvanceCursorOrModifyCache()
        try await tests.testNetworkFailureKeepsPendingEditWithoutRetryStorm()
        try await tests.testConflictKeepsDraftAndLatestServerItem()
        try await tests.testMergingDraftAndExplicitConflictResolutionPreserveOtherFields()
        try await tests.testFailedPersistenceDoesNotAdvanceStateOrCursor()
        try await tests.testOfflineDemoUsesSameClientAndPreservesEditsAcrossRefresh()
        print("PASS: 11 Swift core checks (contract, security, persistence, removal, offline, conflict, demo)")
    }
}
