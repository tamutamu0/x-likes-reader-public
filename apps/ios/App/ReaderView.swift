import SwiftUI
import MarginCore

private enum Shelf: String, CaseIterable, Identifiable {
    case unread = "未読", all = "すべて", later = "あとで", kept = "残す"
    var id: String { rawValue }
}

struct ReaderView: View {
    @Bindable var model: ReaderModel
    @State private var shelf: Shelf = .unread
    @State private var search = ""
    private var filtered: [ReaderItem] {
        model.items.map(model.displayed).filter { item in
            let shelfMatch: Bool
            switch shelf {
            case .unread: shelfMatch = !item.user.read && item.user.state == .inbox
            case .all: shelfMatch = true
            case .later: shelfMatch = item.user.state == .later
            case .kept: shelfMatch = item.user.state == .kept
            }
            let text = [item.source?.text ?? "", item.source?.author.name ?? "", item.user.memo, item.user.tags.joined(separator: " ")].joined(separator: " ")
            return shelfMatch && (search.isEmpty || text.localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("表示", selection: $shelf) {
                        ForEach(Shelf.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).listRowSeparator(.hidden)
                }
                if filtered.isEmpty {
                    ContentUnavailableView(search.isEmpty ? "読み終わりました" : "見つかりませんでした", systemImage: "checkmark.circle", description: Text(search.isEmpty ? "「すべて」から読み返せます。" : "検索する言葉を変えてみてください。"))
                }
                ForEach(filtered) { item in
                    NavigationLink {
                        PostDetail(model: model, id: item.id)
                    } label: {
                        PostRow(item: item, pending: model.snapshot.pending[item.id] != nil)
                    }
                    #if os(iOS)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { Task { await model.update(id: item.id, changes: UserChanges(read: !item.user.read)) } } label: {
                            Label(item.user.read ? "未読" : "既読", systemImage: item.user.read ? "circle" : "checkmark")
                        }.tint(.blue)
                        Button { Task { await model.update(id: item.id, changes: UserChanges(state: item.user.state == .later ? .inbox : .later)) } } label: {
                            Label("あとで", systemImage: "clock")
                        }.tint(.orange)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button { Task { await model.update(id: item.id, changes: UserChanges(state: item.user.state == .kept ? .inbox : .kept)) } } label: {
                            Label("残す", systemImage: "bookmark")
                        }.tint(.indigo)
                    }
                    #endif
                }
                Section {
                    Label(model.isDemo ? "架空データで試しています" : "ローカルAPIに接続中", systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Xのいいね取得はまだ接続していません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("margin")
            .searchable(text: $search, prompt: "投稿・メモ・タグを検索")
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem {
                    Button { Task { await model.refresh() } } label: { Label("更新", systemImage: "arrow.clockwise") }
                        .disabled(model.isLoading)
                }
            }
            .overlay { if model.isLoading && model.items.isEmpty { ProgressView("読み込み中") } }
            .alert("お知らせ", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("閉じる", role: .cancel) { model.message = nil }
            } message: { Text(model.message ?? "") }
        }
    }
}

private struct PostRow: View {
    let item: ReaderItem
    let pending: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(item.source?.author.name ?? "元の投稿は表示できません").font(.subheadline.weight(.semibold))
                Spacer()
                if !item.user.read { Circle().fill(.blue).frame(width: 7, height: 7).accessibilityLabel("未読") }
            }
            if let source = item.source {
                Text("@\(source.author.handle)").font(.caption).foregroundStyle(.secondary)
                Text(source.text).font(.body).lineLimit(5)
            }
            if !item.user.memo.isEmpty { Label(item.user.memo, systemImage: "note.text").font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if pending { Text("保存待ちの変更があります").font(.caption).foregroundStyle(.orange) }
            if !item.user.tags.isEmpty { Text(item.user.tags.map { "#\($0)" }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 8)
    }
}

private struct PostDetail: View {
    @Bindable var model: ReaderModel
    let id: String
    @State private var editing = false
    private var item: ReaderItem? { model.snapshot.items[id].map(model.displayed) }
    var body: some View {
        Group {
            if let item {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(item.source?.author.name ?? "元の投稿は表示できません").font(.headline)
                            if let source = item.source {
                                Text("@\(source.author.handle)").font(.subheadline).foregroundStyle(.secondary)
                                Text(source.text).font(.body).textSelection(.enabled)
                                if let url = safeURL(source.url) { Link("Xで開く", destination: url).font(.subheadline) }
                                ForEach(source.links, id: \.url) { link in
                                    if let url = safeURL(link.url) { Link(link.title, destination: url) }
                                }
                            } else { Text("元の投稿が削除・非公開になった場合も、自分のメモは残せます。").foregroundStyle(.secondary) }
                        }
                        HStack {
                            Button { Task { await model.update(id: id, changes: UserChanges(read: !item.user.read)) } } label: {
                                Label(item.user.read ? "未読に戻す" : "既読にする", systemImage: "checkmark")
                            }
                            Button { Task { await model.update(id: id, changes: UserChanges(state: item.user.state == .kept ? .inbox : .kept)) } } label: {
                                Label(item.user.state == .kept ? "残すを解除" : "残す", systemImage: "bookmark")
                            }
                        }.buttonStyle(.bordered)
                        Divider()
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("メモ").font(.headline); Spacer()
                                Button("編集") { editing = true }
                            }
                            Text(item.user.memo.isEmpty ? "気になったことを残しておけます。" : item.user.memo)
                                .foregroundStyle(item.user.memo.isEmpty ? .secondary : .primary)
                                .textSelection(.enabled)
                            if let draft = model.snapshot.pending[id], draft.hasConflict {
                                Label("別の端末の更新と下書きがあります", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange)
                                Text("下書きは上書きせずに残しています。「編集」で両方を確認できます。").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }.padding(20).frame(maxWidth: 640, alignment: .leading).frame(maxWidth: .infinity)
                }
                .navigationTitle("投稿")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .sheet(isPresented: $editing) { MemoEditor(model: model, id: id) }
            } else { ContentUnavailableView("投稿が見つかりません", systemImage: "doc") }
        }
    }
}

private struct MemoEditor: View {
    @Bindable var model: ReaderModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var memo = ""
    @State private var saving = false
    @State private var loaded = false
    var body: some View {
        NavigationStack {
            Form {
                if let pending = model.snapshot.pending[id], pending.hasConflict,
                   let server = model.snapshot.items[id] {
                    Section("ほかの端末で保存されたメモ") { Text(server.user.memo.isEmpty ? "メモなし" : server.user.memo).textSelection(.enabled) }
                    Section { Text("下のメモを確認して保存すると、最新の投稿に対して更新します。").font(.caption) }
                }
                Section("自分のメモ") { TextEditor(text: $memo).frame(minHeight: 180).accessibilityLabel("メモ本文") }
                if let message = model.message { Section { Text(message).font(.caption).foregroundStyle(.orange) } }
            }
            .navigationTitle("メモを編集")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        saving = true
                        Task {
                            let saved = await model.update(id: id, changes: UserChanges(memo: memo), resolvingConflict: true)
                            saving = false
                            if saved { dismiss() }
                        }
                    }.disabled(saving || memo.count > 10000)
                }
            }
            .onAppear {
                guard !loaded else { return }; loaded = true
                if let item = model.snapshot.items[id] { memo = model.displayed(item).user.memo }
            }
            .interactiveDismissDisabled(saving)
        }
    }
}

private func safeURL(_ raw: String) -> URL? {
    guard let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
    return url
}
