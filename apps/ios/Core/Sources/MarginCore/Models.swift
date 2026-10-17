import Foundation

// Wire models follow packages/contracts/openapi.json. IDs remain strings.
public struct Author: Codable, Equatable, Sendable {
    public var name: String
    public var handle: String
}
public struct Link: Codable, Equatable, Sendable {
    public var url: String
    public var title: String
}
public struct Source: Codable, Equatable, Sendable {
    public var postId: String
    public var url: String
    public var author: Author
    public var text: String
    public var postedAt: String?
    public var links: [Link]
}
public enum ReadingState: String, Codable, Sendable { case inbox, later, kept, done }
public struct UserState: Codable, Equatable, Sendable {
    public var state: ReadingState
    public var read: Bool
    public var laterUntil: String?
    public var tags: [String]
    public var memo: String
    public var genre: String?
}
public struct Metadata: Codable, Equatable, Sendable {
    public enum Origin: String, Codable, Sendable { case sample, x }
    public enum SourceStatus: String, Codable, Sendable { case available, removed, pending, expired }
    public var origin: Origin
    public var fictional: Bool
    public var sourceStatus: SourceStatus
    public var fetchedAt: String
    public var likedAt: String? = nil
}
public struct ReaderItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var revision: Int
    public var updatedAt: String
    public var source: Source?
    public var user: UserState
    public var metadata: Metadata
}
public struct ItemPage: Codable, Sendable {
    public var items: [ReaderItem]
    public var nextCursor: String?
    public init(items: [ReaderItem], nextCursor: String?) { self.items = items; self.nextCursor = nextCursor }
}
public struct Change: Codable, Sendable {
    public var cursor: Int
    public var item: ReaderItem
    public init(cursor: Int, item: ReaderItem) { self.cursor = cursor; self.item = item }
}
public struct ChangePage: Codable, Sendable {
    public var changes: [Change]
    public var nextCursor: Int
    public var hasMore: Bool
    public init(changes: [Change], nextCursor: Int, hasMore: Bool) { self.changes = changes; self.nextCursor = nextCursor; self.hasMore = hasMore }
}
public enum NullableString: Codable, Equatable, Sendable {
    case value(String), null
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        self = c.decodeNil() ? .null : .value(try c.decode(String.self))
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .null: try c.encodeNil(); case .value(let value): try c.encode(value) }
    }
    public var value: String? { if case .value(let v) = self { return v }; return nil }
}
public struct UserChanges: Codable, Equatable, Sendable {
    public var state: ReadingState?
    public var read: Bool?
    public var laterUntil: NullableString?
    public var tags: [String]?
    public var memo: String?
    public var genre: NullableString?
    public init(state: ReadingState? = nil, read: Bool? = nil, laterUntil: NullableString? = nil, tags: [String]? = nil, memo: String? = nil, genre: NullableString? = nil) {
        self.state = state; self.read = read; self.laterUntil = laterUntil
        self.tags = tags; self.memo = memo; self.genre = genre
    }
    private enum CodingKeys: String, CodingKey { case state, read, laterUntil, tags, memo, genre }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(ReadingState.self, forKey: .state)
        read = try c.decodeIfPresent(Bool.self, forKey: .read)
        tags = try c.decodeIfPresent([String].self, forKey: .tags)
        memo = try c.decodeIfPresent(String.self, forKey: .memo)
        // decodeIfPresent would lose explicit null (clear) and treat it as an
        // omitted field (keep), corrupting a draft after app restart.
        laterUntil = c.contains(.laterUntil) ? try c.decode(NullableString.self, forKey: .laterUntil) : nil
        genre = c.contains(.genre) ? try c.decode(NullableString.self, forKey: .genre) : nil
    }
    public var isEmpty: Bool { state == nil && read == nil && laterUntil == nil && tags == nil && memo == nil && genre == nil }
    public func merging(_ newer: UserChanges) -> UserChanges {
        UserChanges(state: newer.state ?? state, read: newer.read ?? read,
                    laterUntil: newer.laterUntil ?? laterUntil, tags: newer.tags ?? tags,
                    memo: newer.memo ?? memo, genre: newer.genre ?? genre)
    }
    public func applying(to current: UserState) -> UserState {
        var result = current
        if let state { result.state = state }; if let read { result.read = read }
        if let laterUntil { result.laterUntil = laterUntil.value }; if let tags { result.tags = tags }
        if let memo { result.memo = memo }; if let genre { result.genre = genre.value }
        return result
    }
}
public struct PatchRequest: Codable, Sendable {
    public var expectedRevision: Int
    public var changes: UserChanges
}
public struct APIProblem: Codable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}
public struct ErrorEnvelope: Codable, Sendable { public var error: APIProblem }
public struct ConflictEnvelope: Codable, Sendable {
    public var error: APIProblem
    public var item: ReaderItem
    public init(error: APIProblem, item: ReaderItem) { self.error = error; self.item = item }
}
