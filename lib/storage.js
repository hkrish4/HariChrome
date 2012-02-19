storage = {
  store: function(key, value) {
    localStorage[storage.keyWithPrefix(key)] = value;
  },

  read: function(key) {
    return localStorage[storage.keyWithPrefix(key)];
  },
  
  keys: function() {
    var keys = [];
    for (var key in localStorage) {
      if (storage.hasPrefix(key) || !storage.prefixDefined()) {
        var newKey = storage.removePrefix(key);
        if (!newKey.match(/^(config|extensionOptions)$/)) {
          keys.push(newKey);
        }
      }
    }
    return keys;
  },
  
  keyWithPrefix: function(key) {
    return storage.prefixDefined() ? PROPERTY_PREFIX + key : key;
  },

  removePrefix: function(key) {
    return storage.hasPrefix(key) ? key.replace(PROPERTY_PREFIX, "") : key;
  },
  
  hasPrefix: function(key) {
    if (!storage.prefixDefined()) return false;
    
    return key.indexOf(PROPERTY_PREFIX) == 0;
  },
  
  prefixDefined: function() {
    return !(typeof PROPERTY_PREFIX == "undefined");
  }
  
}