chrome.extension.onRequest.addListener(function (request, sender, sendResponse) {
  invisiblehand.handleExtensionRequest(request, sender, sendResponse);
});