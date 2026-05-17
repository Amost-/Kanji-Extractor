//
//  KanjiExtractorApp.swift
//  Shared (App)
//
//  Cross-platform host app for the Kanji Extractor Safari Web Extension.
//

import SwiftUI
#if os(macOS)
import AppKit
import SafariServices
#elseif os(iOS)
import UIKit
#endif

@main
struct KanjiExtractorApp: App {
    var body: some Scene {
        WindowGroup("Kanji Extractor") {
            ContentView()
                #if os(macOS)
                .frame(width: 460, height: 390)
                #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}

struct AppIconView: View {
    private let image = PlatformImage.loadExtensionIcon()

    var body: some View {
        Group {
            if let image {
                #if os(macOS)
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                #elseif os(iOS)
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                #endif
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

#if os(macOS)
private typealias PlatformImage = NSImage
#elseif os(iOS)
private typealias PlatformImage = UIImage
#endif

private extension PlatformImage {
    static func loadExtensionIcon() -> PlatformImage? {
        guard let iconURL = Bundle.main.extensionIconURL() else {
            return nil
        }

        #if os(macOS)
        return PlatformImage(contentsOf: iconURL)
        #elseif os(iOS)
        return PlatformImage(contentsOfFile: iconURL.path)
        #endif
    }
}

private extension Bundle {
    func extensionIconURL() -> URL? {
        if let appIconURL = url(forResource: "icon-128", withExtension: "png", subdirectory: "icons") {
            return appIconURL
        }

        guard let builtInPlugInsURL,
              let plugInURLs = try? FileManager.default.contentsOfDirectory(
                at: builtInPlugInsURL,
                includingPropertiesForKeys: nil
              ) else {
            return nil
        }

        for plugInURL in plugInURLs where plugInURL.pathExtension == "appex" {
            guard let extensionBundle = Bundle(url: plugInURL) else {
                continue
            }

            if let iconURL = extensionBundle.url(
                forResource: "icon-128",
                withExtension: "png",
                subdirectory: "icons"
            ) {
                return iconURL
            }
        }

        return nil
    }
}

struct ContentView: View {
    private let extensionBundleIdentifier = "it.tomas.Kanji-Extractor-Safari.Extension"

    var body: some View {
        VStack(spacing: 16) {
            AppIconView()
                .frame(width: 72, height: 72)

//            Image(systemName: "character.book.closed")
//                .font(.system(size: 48))
//                .foregroundStyle(.tint)

            Text("Kanji Extractor")
                .font(.title)
                .bold()

            #if os(macOS)
            Text("Enable the extension in Safari to extract kanji terms from any web page.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)

            Button("Open Safari Extensions Preferences") {
                openSafariExtensionPreferences()
            }
            .controlSize(.large)
            #elseif os(iOS)
            Text("Enable the extension in Settings → Apps → Safari → Extensions.\nIn Safari tap the puzzle-piece button while viewing a web page.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            //unable to make sandbox extension: [22: Invalid argument] ??
            Button("Open Settings") {
                openSafariExtensionPreferences()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            #endif

            Divider()

            VStack(spacing: 6) {
                Text("Privacy Policy")
                    .font(.headline)

                Text("Kanji Extractor processes the current web page locally in Safari only after you click Extract. \nIt does not collect, store, track, sell, or upload your browsing data, extracted text, or downloaded files.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal)
        }
        .padding(24)
    }
    //unable to make sandbox extension: [22: Invalid argument] ?
    @MainActor
    private func openSafariExtensionPreferences() {
        #if os(macOS)
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: extensionBundleIdentifier
        ) { error in
            if let error {
                NSLog("Failed to open Safari extension prefs: \(error)")
            }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
        #elseif os(iOS)
        if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(settingsURL)
        }
        #endif
    }
}
