import SwiftUI

@main struct MarginApp: App {
    @State private var model = ReaderModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ReaderView(model: model).task { await model.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.refresh() } }
                }
        }
    }
}
