import UIKit
import Social
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {
    
    private var sharedImage: UIImage?
    private var sharedURL: URL?
    private var sharedText: String?
    
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Share to WYA"
        placeholder = "Add a note..."
        
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return }
        
        for item in items {
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                // Images
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
                        if let url = data as? URL, let imgData = try? Data(contentsOf: url) {
                            self?.sharedImage = UIImage(data: imgData)
                        } else if let img = data as? UIImage {
                            self?.sharedImage = img
                        }
                    }
                }
                // URLs
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] data, _ in
                        self?.sharedURL = data as? URL
                    }
                }
                // Text
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, _ in
                        self?.sharedText = data as? String
                    }
                }
            }
        }
    }
    
    override func isContentValid() -> Bool { true }
    
    override func didSelectPost() {
        // Send shared content to WYA backend
        let note = contentText ?? ""
        var payload: [String: Any] = ["note": note, "source": "share_extension"]
        
        if let url = sharedURL {
            payload["url"] = url.absoluteString
            // Check if it's a Maps URL with coordinates
            if url.absoluteString.contains("maps") || url.absoluteString.contains("place") {
                payload["type"] = "location"
            }
        }
        if let text = sharedText {
            payload["text"] = text
        }
        
        // Upload image if present
        if let image = sharedImage, let jpegData = image.jpegData(compressionQuality: 0.8) {
            payload["has_image"] = true
            payload["image_base64"] = jpegData.base64EncodedString()
        }
        
        guard let url = URL(string: "https://wya.digisigns.link/api/ios/share-ingest"),
              let jsonData = try? JSONSerialization.data(withJSONObject: payload) else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }.resume()
    }
    
    override func configurationItems() -> [Any]! { [] }
}
