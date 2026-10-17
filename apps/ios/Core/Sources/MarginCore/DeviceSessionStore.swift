#if canImport(Security)
import Foundation
import Security

public enum SessionStoreError: Error { case keychain(OSStatus), invalidData }
public struct DeviceSessionStore: Sendable {
    public init() {}
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "margin.device-session", kSecAttrAccount as String: "owner"]
    }
    public func load() throws -> String? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SessionStoreError.keychain(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw SessionStoreError.invalidData }
        return value
    }
    public func save(_ token: String) throws {
        let data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw SessionStoreError.keychain(status) }
        var q = query; q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(q as CFDictionary, nil)
        guard added == errSecSuccess else { throw SessionStoreError.keychain(added) }
    }
    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionStoreError.keychain(status) }
    }
}
#endif
