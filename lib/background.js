var volatileStorage = {};
var COOKIE_NAME = "InvisibleHandExtension";
var COOKIE_URL = "http://www.getinvisiblehand.com"

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.url) {
    setTimeout(function() {
      chrome.tabs.sendRequest(tabId, {topic: "refreshed", url: changeInfo.url}, function(response) {});
    }, 500)
  }
});

invisiblehand = {
  handleExtensionRequest: function(request, sender, sendResponse) {
    switch (request.topic) {
      case 'opennewtab':
        chrome.tabs.create({ url: request.address });
        break;
      case 'run':                     
        extensionProperties(function (props) {
          sendResponse({extensionOptions: extensionOptions(), extensionProperties: props});
        });
        break;
      case 'cache':                
        sendResponse(cache(request.key, request.value));
        break;
      case 'saveProperty':                                            
        saveProperty(request.key, request.value, function(props) {
          sendResponse(props);  
        });
        break;  
      // heartbeat is not in use anymore?
      case 'heartbeat':
        sendResponse({alive: true})
        break;
      case 'htmlRequest':
        ajaxRequest(request.location.href, request.data, request.method, function (xhr) {
            sendResponse(xhr.responseText);
        });
        break;
      case 'trackActiveUser':
        _gaq.push(['_setAccount', 'UA-21876973-8']);
        _gaq.push(['_trackPageview']);
        break;
      case 'ihContentScript':
        sendResponse(IH_CONTENT_SCRIPT);
        break;  
      default:
        sendResponse({});
    }
  }    
}        

function saveProperty(key, value, callback) {
  storage.store(key, value);
  extensionProperties(callback);
}

function extensionOptions() {
  var defaultOptions = {'products-search-engines-enabled': true, 'products-ebay-enabled': true, 'flights-enabled': true, 'products-related-items-enabled': true};
  try {
    var options = JSON.parse(storage.read('extensionOptions'));
    for (o in defaultOptions) {
      if (options[o] == undefined) 
        options[o] = defaultOptions[o];
    }
  } catch(e) {}
  return options || defaultOptions;
}

function storeSettingsLink() {
  storage.store("settingsLink", chrome.extension.getURL('html/options.html'))
}

function extensionProperties(callback) {
  var props = {};
  storeSettingsLink();
  
  var keys = storage.keys();
  for (var i in keys) {
    props[keys[i]] = storage.read(keys[i]);   
  }
  callback(props);
}

function cache(key, value) {
  var timestamp = new Date().getTime();
  if (value == undefined) {
    var cached = this.volatileStorage[key];
    if (cached && timestamp - cached.timestamp < 86400000) {
      return cached.value;
    }
  } else {
    this.volatileStorage[key] = {value:value, timestamp:timestamp};
    return value;
  }
}      

function ajaxRequest(url, data, method, successCallback) {
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if ((xhr.readyState == 4) && successCallback) successCallback.call(this, xhr);
  };
  xhr.open(method, url, true);
  xhr.send(data);
}
