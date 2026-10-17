import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum ClientError: Error, Sendable {
    case invalidConfiguration, invalidResponse, invalidItemID, tooManyPages
    case http(Int, APIProblem?), conflict(ReaderItem), missingItem
}
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.httpCookieStorage = nil
        self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        return (data, response.statusCode)
    }
}
public struct APIClient: Sendable {
    private let baseURL: URL
    private let token: String?
    private let localDevelopment: Bool
    private let transport: any HTTPTransport

    public init(baseURL: URL, token: String? = nil, localDevelopment: Bool = false, transport: any HTTPTransport = URLSessionTransport()) throws {
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(baseURL.host ?? "")
        guard baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil,
              baseURL.host != nil, baseURL.path.isEmpty || baseURL.path == "/",
              baseURL.scheme == "https" || (localDevelopment && loopback && baseURL.scheme == "http"),
              !localDevelopment || loopback else { throw ClientError.invalidConfiguration }
        self.baseURL = baseURL; self.token = token
        self.localDevelopment = localDevelopment; self.transport = transport
    }

    private func request<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], body: PatchRequest? = nil) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw ClientError.invalidConfiguration }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if localDevelopment { request.setValue("1", forHTTPHeaderField: "X-Margin-Request") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, status) = try await transport.send(request)
        if status == 409, let conflict = try? JSONDecoder().decode(ConflictEnvelope.self, from: data) { throw ClientError.conflict(conflict.item) }
        guard (200..<300).contains(status) else {
            throw ClientError.http(status, (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func items(cursor: String? = nil, limit: Int = 50) async throws -> ItemPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("v1/items", query: query)
    }
    public func item(id: String) async throws -> ReaderItem {
        try validate(id); return try await request("v1/items/\(id)")
    }
    public func patch(id: String, expectedRevision: Int, changes: UserChanges) async throws -> ReaderItem {
        try validate(id)
        return try await request("v1/items/\(id)", body: PatchRequest(expectedRevision: expectedRevision, changes: changes))
    }
    public func changes(after: Int, limit: Int = 50) async throws -> ChangePage {
        try await request("v1/changes", query: [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "limit", value: String(limit))])
    }
    private func validate(_ id: String) throws {
        guard id.range(of: "^x:[0-9]{1,25}$", options: .regularExpression) != nil else { throw ClientError.invalidItemID }
    }
}
