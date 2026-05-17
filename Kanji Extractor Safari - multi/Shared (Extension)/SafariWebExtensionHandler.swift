//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Bridges native Safari calls to the Web Extension.
//
//  The popup handles file output directly: Web Share API on iOS and an injected
//  anchor download on macOS. This native handler only acknowledges messages and
//  reports accidental native share requests as unsupported.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from web extension: %@", String(describing: message))

        if let dict = message as? [String: Any],
           let action = dict["action"] as? String,
           action == "share" {
            Self.completeRequest(context: context, with: [
                "status": "error",
                "error": "Native sharing is not available from the Safari extension."
            ])
            return
        }

        // Default: ack so the popup's sendNativeMessage promise resolves.
        Self.completeRequest(context: context, with: ["status": "ok"])
    }

    private static func completeRequest(context: NSExtensionContext, with payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
