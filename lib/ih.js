com.forward.invisiblehand.constants = {
    statServer: 'data.invisiblehand.co.uk',
    infoUrl: "http://www.getinvisiblehand.com/help/gettingstarted"
};

com.forward.invisiblehand.common = {}

com.forward.invisiblehand.common.utils = {

    buildUrl: function (server, params, secure) {
      var parts = [secure ? 'https' : 'http', '://', server];
      if (params) parts.push("?");

      for (var i in params) {
        if (typeof params[i] !== "undefined" && params[i] !== null) {
          parts.push('&');
          parts.push(i);
          parts.push('=');
          parts.push(encodeURIComponent(params[i]));
        }
      }

      return parts.join('');
    }
}

com.forward.invisiblehand.common.htmlScraper = function (data, scraper, browser) {
  this.data    = data;
  this.scraper = scraper;
  this.results = {};
  this.fields  = this.extractFields();
  this.getUrl  = browser.getUrl;
  this.browser = browser;
}

com.forward.invisiblehand.common.htmlScraper.prototype = {

  scrape: function(externalCallback) {
    if (this.scraper.js) return this.jsScrape(this.scraper.js, externalCallback);
    this.scrapeAllFields(externalCallback);
  },

  extractFields: function() {
    var fields = [];
    for (var fieldName in this.scraper)
      fields.push(fieldName);
    return fields;
  },

  scrapeAllFields: function(externalCallback) {
    var field = this.fields.pop();
    if (!field) return externalCallback(this.results);
    var self = this;
    this.scrapeField(field, function(){
      self.scrapeAllFields(externalCallback);
    });
  },

  normalizePrice: function(price) {
    price = price.replace(/[^,.\d]/, '');
    if (this.isGermanPrice(price)) return this.normalizeGermanPrice(price);
    if (this.isNormalPrice(price)) return this.normalizeNormalPrice(price);
    return price;
  },

  isGermanPrice: function(price) {
    return (price.indexOf(',') > -1) && (price.indexOf(',') > price.indexOf('.'));
  },

  isNormalPrice: function(price) {
    return (price.indexOf('.') > -1) && (price.indexOf('.') > price.indexOf(','));
  },

  normalizeGermanPrice: function(price) { // 1.800,99
    price = price.replace('.', '').replace(',', '.');
    return parseFloat(price);
  },

  normalizeNormalPrice: function(price) { // 1,800.99
    price = price.replace(',', '');
    return parseFloat(price);
  },

  normalizeScrapedValue: function(field, scrapedValue) {
    if (!scrapedValue) return;
    scrapedValue = scrapedValue.toString().replace(/[\x00-\x1F"]/g, ''); // replaces control characters and a quote to avoid problems with JSON later
    if (field == 'price') return this.normalizePrice(scrapedValue) || undefined;
    return scrapedValue;
  },

  scrapeField: function(field, callback){
		var self = this;
    this.tryScrapingUsingRegex(field, function() {
			if (self.results[field])
				callback()
			else
				self.tryScrapingUsingJS(field, callback);
		});
  },

  tryScrapingUsingRegex: function(field, callback) {
    if (!this.scraper[field].regex) {
			callback();
			return;
		}
    var scraped = this.regexScrape(this.data, this.scraper[field].regex);
    return this.processScrapedValue(field, scraped, callback);
  },

  tryScrapingUsingJS: function(field, callback) {
    if (!this.scraper[field].js) {
      callback();
      return;
    }
    var self = this;
    this.jsScrape(this.scraper[field].js, function(scrapedValue) {
      self.processScrapedValue(field, scrapedValue, callback);
    });
  },

  processScrapedValue: function(field, scrapedValue, callback) {
    if(!scrapedValue) {
      callback();
      return;
    }
    var scrapedValue = this.normalizeScrapedValue(field, scrapedValue);
    this.results[field] = scrapedValue;
    callback();
    return !!scrapedValue;
  },

  regexScrape: function(html, regex) {
    var match = html.match(new RegExp(regex, 'i'));
    if (match) return match[1];
    return;
  },

  jsScrape: function(js, externalCallback) {
    this.browser.executeJavaScript(js, { html: this.data, getHttp: this.getUrl, callback: externalCallback, scrapeField: this.regexScrape });
  }

}

com.forward.invisiblehand.common.domScraper = function (browser, scraper) {
  this.browser = browser;
  this.$       = browser.jQuery;
  this.address = browser.currentUrl();
  this.scraper = scraper;
  this.results = {}; // we want to keep them since we need to return everything for delayed and volatile scrapers
}

com.forward.invisiblehand.common.domScraper.prototype = {

  scrape: function(externalCallback) {
    var self = this;
    this.browser.getInnerHtml(function(html) {
      self.html = html;
      self.scrapeAllFields(externalCallback);
    });

  },

  /*
  * Most scrapers are syncronous, that's why we are using the for loop and firing the callback before returning
  * If we encounter an asynchronous scraper, the callback will be called one or more times
  * If there are no synchronous scrapers provided, the callback will not be fired immediately
  */
  scrapeAllFields: function(externalCallback) {
    if (this.scraper.js) {
      this.tryScrapingUsingJsAsync(this.scraper.js, externalCallback);
    }
    for (var fieldName in this.scraper) {
      var scrapedValue = this.scrapeField(fieldName, externalCallback);
      if (scrapedValue) {
        this.results[fieldName] = scrapedValue;
      }
    }
    externalCallback(this.results);
  },

  /*
  * If it's possible to scrape syncronously, we just return the value
  * Otherwise we should return undefined and call the externalCallback when the data is ready
  */
  scrapeField: function(field, externalCallback) {
    var timeout = parseInt(this.scraper[field].wait_for || this.scraper[field].rescrape_for); // it's in seconds on the server-side

    return timeout ? this.scrapeChangingField(field, timeout, externalCallback) : this.tryAllScrapingTechniques(field);
  },

  tryAllScrapingTechniques: function(field) {
    var scraper = this.scraper[field];
    return this.tryScrapingUsingRegex(scraper.regex)
        || this.tryScrapingUsingJsSync(scraper.js)
        || this.tryScrapingUrl(scraper.url_param)
        || this.tryScrapingElementContent(scraper.element_text || scraper.form_field)
        || this.tryScrapingMinValue(scraper.min_value)
        || this.tryScrapingSumOfValues(scraper.sum_values);
  },

  tryScrapingSumOfValues: function(selector) {
    if (!selector) return;
    var self = this;
    var sum = 0;

    this.$(selector).each(function(index, element) {
      var floatValue = self.parseFloatAggressively($(element).text());
      if (floatValue) sum += floatValue;
    });

    return Math.round(sum * 100) / 100.0;
  },

  parseFloatAggressively: function(text) {
    return parseFloat(text.replace(/[^\d\.]/g, ""));
  },

  tryScrapingMinValue: function(selector) {
    if (!selector) return;
    var self = this;
    var values = [];

    this.$(selector).each(function(index, element) {
      var floatValue = self.parseFloatAggressively($(element).text());
      if (floatValue) values.push(floatValue);
    });

    if (values.length > 0) return Math.min.apply(Math, values);
  },

  tryScrapingElementContent: function(selector) {
    if (!selector) return;
    var elements = this.$(selector);
    if (elements.length > 0) return elements.eq(0).val() || elements.eq(0).text();
  },

  tryScrapingUrl: function(regex) {
    if (!regex) return;
    var unescaped = unescape(this.address);
    var match = unescaped.match(new RegExp(regex + "=(.+?)&", 'i'));
    if (match) return match[1];
  },

  scrapeChangingField: function(field, timeout, externalCallback) {
    var intervalId,
        intervalInvocations = 0,
        self = this,
        stopWhenScraped = !!this.scraper[field].wait_for;

    intervalId = setInterval(function() {
      if (++intervalInvocations >= timeout) clearInterval(intervalId); // it's ++intervalInvocations because we have to wait 1 sec before the first invocation
      self.results[field] = self.tryAllScrapingTechniques(field);
      if (self.results[field]) {
        if (stopWhenScraped) clearInterval(intervalId);
        externalCallback(self.results);
      }
    }, 1000); // this has to be 1 second since it's specified in seconds on the server-side
  },

  tryScrapingUsingRegex: function(regex) {
    return this.scrapeHtmlUsingRegex(this.html, regex);
  },

  scrapeHtmlUsingRegex: function(html, regex) {
    if (!regex) return;
    html = html.replace(/\ssizcache="\d+"/, "").replace(/\ssizset="\d+"/, "");
    var match = html.match(new RegExp(regex, 'i'));
    if (match) return match[1];
  },

  tryScrapingUsingJsSync: function(jsCode) {
    if (!jsCode) return;

    var results;
    this.jsScrape(jsCode, function(scrape) { results = scrape });
    return results;
  },

  tryScrapingUsingJsAsync: function(jsCode, externalCallback) {
    if (!jsCode) return;
    var self = this;
    this.jsScrape(jsCode, function(scrape) {
      for (field in scrape) {
        self.results[field] = scrape[field];
      }
      externalCallback(self.results);
    });
  },

  jsScrape: function(js, externalCallback) {
    this.browser.executeJavaScript(js, { html: this.html, "$ih": this.$, callback: externalCallback, scrapeField: this.scrapeHtmlUsingRegex });
  }


}

com.forward.invisiblehand.extension = function (browser) {
  this.browser = browser;
  this.properties = {};
  this.notificationsCount = {};
  this.messageQueue = [];
  this.trackingDivId = "tc_container";
  this.executionCancelled = null;
};

com.forward.invisiblehand.extension.prototype = {

    setProperties: function (properties) {
        properties.domain = "invisiblehand.co.uk";
        properties.trackingCode = "ih";
        if(!properties.source || !properties.source.match(/^conduit/)) properties.source = "ih";
        this.properties = properties;
    },

    setProperty: function (key, value) {
        var self = this;
        this.browser.saveProperty(key, value, function (props) {
            self.setProperties(props);
        });
    },

    htmlScraper: function (data, scraper) {
        return new com.forward.invisiblehand.common.htmlScraper(data, scraper, this.browser);
    },

    domScraper: function (scraper) {
        return new com.forward.invisiblehand.common.domScraper(this.browser, scraper);
    },

    notifyIframeReady: function(){
      this.iframeReady = true;
      this.processMessageQueue();
    },

    processMessageQueue: function(){
      while(this.messageQueue.length > 0){
        var message = this.messageQueue.shift()
        this.postMessage(message);
      }
    },

    queueMessage: function(message){
      if(this.iframeReady) {
        this.postMessage(message);
      } else {
        this.messageQueue.push(message);
      }
    },

    postMessage: function(message){
      this.browser.postMessage(message);
    },

    showNotification: function (iFrameAddress, notification, overridingStylesheet) {
        if (this.browser.competingIframeInjected(iFrameAddress)) {
            this.browser.removeIframe();
        }

        this.browser.insertIframe(iFrameAddress, this);

        this.queueMessage(notification || {});

        if (overridingStylesheet) {
            this.browser.injectStylesheet(overridingStylesheet);
        }
    },

    installationSource: function () {
        return this.properties.source;
    },

    hideNotification: function () {
        this.browser.removeIframe();
    },

    isFirstRun: function () {
        return !this.properties.hasRun;
    },

    generateUid: function () {
        return (new Date().getTime() + Math.random().toString().substring(2));
    },

    generateUidForCurrentUser: function () {
        return "c" + this.generateUid();
    },

    onFirstRun: function () {
        com.forward.invisiblehand.log('First Run');
        var self = this;

        self.setProperty("hasRun", true);

        var uid = this.properties.uid || self.generateUid();
        this.properties.uid = uid; // So not to be rewritten onFirstRunToday
        self.setProperty("uid", uid);

        self.browser.navigateToPage(com.forward.invisiblehand.constants.infoUrl);

        var params = {
            'extension': self.browser.extensionVersion(),
            'browser': self.browser.browserType(),
            'src': self.installationSource(),
            'uid': uid
        };

        var url = com.forward.invisiblehand.common.utils.buildUrl(com.forward.invisiblehand.constants.statServer + '/installation', params);
        com.forward.invisiblehand.httpRequest(url);
    },

    isFirstRunToday: function () {
        var lastUsed = this.properties.activeUser;
        var d = new Date();
        var today = "" + d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
        if (lastUsed != today) {
            this.setProperty("activeUser", today);
            return true;
        }

        return false;
    },

    onFirstRunToday: function () {
        com.forward.invisiblehand.log('First Run Today');

        var uid = this.properties.uid;
        if (!uid) {
            com.forward.invisiblehand.log("No UID fr current user");
            uid = this.generateUidForCurrentUser();
            this.setProperty("uid", uid);
        }

        var params = {
            'extension': this.browser.extensionVersion(),
            'browser': this.browser.browserType(),
            'src': this.properties.source,
            'uid': uid
        };

        var url = com.forward.invisiblehand.common.utils.buildUrl(com.forward.invisiblehand.constants.statServer + '/active', params);
        com.forward.invisiblehand.httpRequest(url);

        com.forward.invisiblehand.trackActiveUser && com.forward.invisiblehand.trackActiveUser();
    },

    runVerticals: function (params) {
      var self = this;
      setTimeout(function() { // timeout is to allow other extenions to run
        if (self.shouldRun()) {
          if (self.browser.debugifier) self.browser.debugifier.run(params.extensionProperties);

          self.browser.removeIframe();

          new com.forward.invisiblehand.products(self, params.extensionOptions).run();

          self.hotels = new com.forward.invisiblehand.hotels(self, params.extensionOptions);
          self.hotels.run();

          self.flights = new com.forward.invisiblehand.flights(self, params.extensionOptions);
          self.flights.run();

          self.rentals = new com.forward.invisiblehand.rentals(self, params.extensionOptions);
          self.rentals.run();

          self.tickets = new com.forward.invisiblehand.tickets(self, params.extensionOptions);
          self.tickets.run();

          self.deals = new com.forward.invisiblehand.deals(self, params.extensionOptions);
          self.deals.run();
        } else {
          com.forward.invisiblehand.log("Disabled " + params.extensionProperties.trackingCode);
        }
      }, 100);
    },

    shouldRun: function() {
      var existingDiv = this.browser.doc.getElementById(this.trackingDivId);
      if (existingDiv == null) return true;

      var trackingCode = this.properties.trackingCode;
      return !this.executionCancelled && existingDiv.getAttribute("data") == trackingCode;
    },

    trackBrokenLocalStorage: function () {
        var params = {
            'browser': this.browser.browserType(),
            'action': 'local_storage_broken'
        };
        var iFrameUrl = com.forward.invisiblehand.common.utils.buildUrl(com.forward.invisiblehand.constants.statServer, params);
        this.browser.insertHiddenIframe(iFrameUrl, "invisiblehand-broken-local-storage-iframe");
    },

    testLocalStorage: function (worksCallback, doesntWorkCallback) {
        var testKey = "localstoragetest";
        var testValue = this.generateUid();
        var self = this;
        this.browser.saveProperty(testKey, testValue, function (props) {
            if (props[testKey] == testValue) {
                worksCallback();
            } else {
                self.trackBrokenLocalStorage();
                doesntWorkCallback();
            }
        });
    },

    runSetup: function (callback) {
        if (this.isFirstRun()) {
            this.onFirstRun();
        }
        if (this.isFirstRunToday()) {
            this.onFirstRunToday();
        }
        callback();
    },

    checkForOtherWhitelabels: function() {
      var self = this;
      var trackingCode = this.properties.trackingCode;
      var body = this.browser.doc.getElementsByTagName("body").item(0);

      var trackingDiv = this.browser.doc.createElement("div");
      trackingDiv.id = this.trackingDivId;
      trackingDiv.setAttribute("style", "display: none");
      trackingDiv.setAttribute("data", trackingCode);

      var existingDiv;
      if ((existingDiv = this.browser.doc.getElementById(this.trackingDivId)) != null) {
        trackingCode == "ih" ? existingDiv.setAttribute("data", trackingCode) : self.executionCancelled = true;
      } else {
        body && body.appendChild(trackingDiv);
      }
    },

    run: function (params) {
        com.forward.invisiblehand.log('Starting extension.');
        this.setProperties(params.extensionProperties);

        this.checkForOtherWhitelabels();

        var self = this;
        this.testLocalStorage(
      function () { self.runSetup(function () { self.runVerticals(params); }) },
      function () { self.runVerticals(params) }
    );
    }

}
com.forward.invisiblehand.debug = function(browser) {
  this.browser = browser;
}

com.forward.invisiblehand.debug.prototype = {

  run: function (properties) {
    if (properties.debugModeEnabled !== "true" && properties.debugModeEnabled !== true) return;

    if (this.browser.window.location.href.indexOf("scraper.html") == -1) this.injectIframe();
  },

  receiveMessage: function (payload) {
    com.forward.invisiblehand.log("[debugifier] receivedMessage: " + JSON.stringify(payload));
    switch (payload.message) {
        case 'enableDebugMode':
            this.enable();
            break;
        case 'disableDebugMode':
            this.disable();
            break;
        case 'closeDebugWindow':
            this.closeDebugWindow();
            break;
        case 'getFromCache':
            var self = this;
            this.browser.cache(payload.params.cacheKey, function(cacheData) {
                self.postMessage({ message: "getFromCache", cacheData: cacheData});
            });
            break;
        case 'runScraper':
            com.forward.invisiblehand.log("[debugifier] runScraper");
            var self = this;
            var scraperType = payload.params.type;
            var scraper = (typeof payload.params.scraper == "string") ? JSON.parse(payload.params.scraper) : payload.params.scraper;
            com.forward.invisiblehand.log("[debugifier] scraper: " + JSON.stringify(scraper));
            var callback = function(results) {
                com.forward.invisiblehand.log("[debugifier] scraped:" + JSON.stringify(results));
                self.postMessage({ message: "runScraper", results: results});
            };

            if (scraperType == "domScraper") {
                var s = new com.forward.invisiblehand.common.domScraper(this.browser, scraper);
                s.scrape(callback);
            } else {
                var scrapeHandler = function(html) {
                    com.forward.invisiblehand.log("[debugifier] scrape using:" + html);
                    var s = new com.forward.invisiblehand.common.htmlScraper(html, scraper, self.browser);
                    s.scrape(callback);
                };
                if (payload.params.use_inner_html) {
                    this.browser.getInnerHtml(scrapeHandler);
                } else {
                    this.browser.getUrl(self.browser.currentUrl(), scrapeHandler);
                }
            }

            break;
    }
  },

  postMessage: function(message) {
    var iframe = this.browser.doc.getElementById('invisiblehand-debugging-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(JSON.stringify(message), '*');
    } else {
      var scriptElement = this.browser.doc.createElement("script");
      scriptElement.type = 'text/javascript';
      scriptElement.id = 'invisiblehand-message-posting-script';
      var text = "var msg = " + JSON.stringify(message) + ";";
      text += "var e=document.getElementById('invisiblehand-debugging-iframe'); if (e) {e.contentWindow.postMessage(JSON.stringify(msg), '*')};";
      scriptElement.text = text;
      var head = this.browser.doc.getElementsByTagName("head").item(0);
      head.appendChild(scriptElement);
      head.removeChild(scriptElement);
    }
  },

  enable: function () {
    var self = this;
    this.browser.saveProperty("debugModeEnabled", true, function (props) {
        self.run(props);
    });
  },

  disable: function () {
    var self = this;
    this.browser.saveProperty("debugModeEnabled", false, function (props) {
        self.closeDebugWindow();
    });
  },

  closeDebugWindow: function() {
    var doc = this.browser.doc;
    var element = doc.getElementById("invisiblehand-debugging-iframe");
    doc.body.removeChild(element);
  },

  injectIframe: function () {
    var doc = this.browser.doc;
    var iframe = doc.createElement("iframe");
    iframe.id = 'invisiblehand-debugging-iframe';
    iframe.src = 'http://ih-debug.s3-website-us-east-1.amazonaws.com/';
    iframe.scrolling = 'no';
    iframe.frameBorder = '0';
    iframe.style.position = 'absolute';
    iframe.style.zIndex = '10000001';
    iframe.style.right = '0';
    iframe.style.top = '200px';
    iframe.style.width = '175px';
    iframe.style.height = '200px';
    doc.body.insertBefore(iframe, doc.body.lastChild);
  }

}
com.forward.invisiblehand.relatedProducts = function (browser, retailers) {
  this.browser = browser;
  this.retailers = retailers;
}

com.forward.invisiblehand.relatedProducts.prototype = {

  sanitizeTitle: function(title) {
    return title.replace(/[\x00-\x1F"]/g, '');
  },

  extractAmazonDomain: function(url) {
    var match = url.match(/(www\.amazon\.(com|co\.uk|de))/i);
    if (!match) return;
    return match[1];
  },

  getTld: function(retailer){
    switch (retailer.region.code) {
      case "US": return 'com'; break;
      case "UK": return 'co.uk'; break;
      case "DE": return 'de'; break;
      default  : return undefined;
    };
  },

  fetchSimilarItems: function(title, callback) {
    if (!title || title == "") return;

    var retailer = this.retailers.getRetailer();
    com.forward.invisiblehand.log("Fetching similar items for " + title);
    var self = this;
    var tld = this.getTld(retailer);
    if (!tld) return;
    var similarItemsUrl = "http://www.amazon." + tld + "/gp/aw/s/ref=is_s_?k=" + escape(title).replace(/%20/g, '+');
    this.browser.getUrl(similarItemsUrl, function(raw) {
      var products = raw.split(/<td width="75px">/);
      var items = [];
      var regex = (tld == 'de') ?
        /gp\/aw\/d\/([0-9A-Z]{10}).+?img src="(.+?)"[\1-\uFFFF]+?([^<>]+)<\/a>.+?dpOurPrice">EUR ([0-9,.]+)/ :
        /gp\/aw\/d\/([0-9A-Z]{10}).+?img src="(.+?)"[\1-\uFFFF]+?([^<>]+)<\/a>.+?dpOurPrice">.([0-9,.]+)/;
      for (var i = 1; i < products.length; i++) {
        var match = products[i].match(regex);
        if (!match) continue;
        var amazon_price = (tld == 'de') ? match[4].replace('.','').replace(',','.') : match[4];
        items.push({title: self.sanitizeTitle(match[3]), price: amazon_price, asin: match[1], image: match[2]});
      }
      callback(items);
    });
  },

  relatedProductsSection: function(html){
    return this.matchFor(/("simswrapper"[\1-\uFFFF]*?next-button)/i, html);
  },

  relatedProductsListMethod: function(html_string){
    if(!html_string) return [];
    return html_string.split(/<li/);
  },

  matchFor: function(regex, html_snippet){
    var match = html_snippet.match(regex);
    if(!match) return;
    return match[1];
  },

  scrapeRelatedItem: function(html_snippet){
    var self = this;
    return {
      image: self.matchFor(/img src="(.*?)"/i, html_snippet),
      asin: self.matchFor(/a\shref=.*?\.amazon\..*?\/dp\/([^\/]{10})/i, html_snippet),
      price: self.matchFor(/"price".*?([\d,.]+)/i, html_snippet),
      title: self.matchFor(/title="(.*?)"/i, html_snippet)
    }
  },

  parseRelatedProducts: function(html){
    var scrapedrelatedProducts = [];
    var relatedProductsArray = this.relatedProductsListMethod(this.relatedProductsSection(html));
    for( var i = 1; i < relatedProductsArray.length; i++ ){
      var scrapedRelatedItem = this.scrapeRelatedItem(relatedProductsArray[i]);
      if(scrapedRelatedItem.price) scrapedrelatedProducts.push(scrapedRelatedItem);
    }
    return scrapedrelatedProducts;
  },

  fetchRelatedProducts: function(url, html, callback) {
    var self = this;
    var domain = this.extractAmazonDomain(url);
    if (!domain) return;
    com.forward.invisiblehand.log("Parsing related items products for " + url);
    callback(this.parseRelatedProducts(html));
  }

}
com.forward.invisiblehand.alternativeHelper = function (retailer, alternative) {
  this.retailer = retailer;
  this.alternative = alternative;
  this.maxPriceDifference = 0.75;
}

com.forward.invisiblehand.alternativeHelper.prototype = {
  pnp: function(scrapeResult){
    return scrapeResult && scrapeResult.pnp || this.alternative.pnp;
  },

  alternativeScrapeFailed: function(scrapeResult) {
    return !scrapeResult || !scrapeResult.price;
  },

  isSuspiciouslyCheap: function(scrapeResult, otherPrice) {
    return otherPrice * (1 - this.maxPriceDifference) > scrapeResult.price;
  },

  title: function(scrapeResult){
    return scrapeResult.title && scrapeResult.title.replace(/[\x00-\x1F"]/g, '');
  },

  toJson: function(scrapeResult){
    var json = { retailer : this.retailer.name };
    for (var property in this.alternative) {
        if (this.alternative.hasOwnProperty(property)) {
            json[property] = this.alternative[property];
        }
    }
    json["title"] = this.title(scrapeResult);
    json["price"] = scrapeResult.price;
    json["pnp"] = this.pnp(scrapeResult);
    json["reviews"] = scrapeResult.reviews;

    return json;
  }
}
com.forward.invisiblehand.alternative = function (retailer, alternative, extension, options) {
  this.retailer = retailer;
  this.url = alternative.scraping_address;
  this.extension = extension;
  this.browser = extension.browser;
  this.options = options;
  this.helper = new com.forward.invisiblehand.alternativeHelper(this.retailer, alternative)
}

com.forward.invisiblehand.alternative.prototype = {

  shouldFetchSimilarItems: function(scrapeResult){
    return this.retailer.category != 'search_engine' && this.options['products-related-items-enabled'] && scrapeResult.price;
  },

  shouldFetchRelatedProducts: function() {
    return (this.retailer.category != 'search_engine') && this.options['products-related-items-enabled'];
  },

  scrapeHandler: function(scrapingCallback){
    var self = this;
    return function(html){
      var scraper = self.extension.htmlScraper(html, self.retailer.scraper);
      scraper.scrape(function(scrapeResult) {
        scrapingCallback(scrapeResult, html);
      });
    };
  },

  scrape: function(notification, currentPage){
    var self = this;

    var scrapingCallback = function(scrapeResult, html) {

      if (self.helper.alternativeScrapeFailed(scrapeResult) || self.helper.isSuspiciouslyCheap(scrapeResult, currentPage.price())) {
        return;
      }
      notification.sendMessage({alternative: self.helper.toJson(scrapeResult)});
    };

    this.browser.getUrl(this.url, this.scrapeHandler(scrapingCallback));
  }

}
com.forward.invisiblehand.ebayAlternative = function (retailer, alternative) {
  this.helper = new com.forward.invisiblehand.alternativeHelper(retailer, alternative);
  this.alternative = alternative;
}

com.forward.invisiblehand.ebayAlternative.prototype = {

  scrape: function(notification, currentPage) {
    var scrapeResult = { price: this.alternative.price, title: this.alternative.title, pnp: this.alternative.pnp };
    if (this.helper.alternativeScrapeFailed(scrapeResult) || this.helper.isSuspiciouslyCheap(scrapeResult, currentPage.price())) {
      return;
    }
    notification.sendMessage({alternative: this.helper.toJson(scrapeResult)});
  }

}
com.forward.invisiblehand.amazonAlternative = function (retailer, alternative, extension, relatedProducts) {
  this.url = alternative.scraping_address;
  this.extension = extension;
  this.browser = extension.browser;
  this.retailer = retailer;
  this.relatedProducts = relatedProducts;
  this.helper = new com.forward.invisiblehand.alternativeHelper(this.retailer, alternative);
}

com.forward.invisiblehand.amazonAlternative.prototype = {

  relatedProductsCallback: function(relatedProducts, notification){
    notification.sendMessage({relatedProducts: relatedProducts});
  },

  shouldFetchRelatedProducts: function(){
    return false;
  },

  shouldFetchSimilarItems: function(){
    return false;
  },

  scrapeHandler: function(scrapingCallback){
    var self = this;
    return function(html){
      var scraper = self.extension.htmlScraper(html, self.retailer.scraper);
      scraper.scrape(function(scrapeResult) {
        scrapingCallback(scrapeResult, html);
      });
    };
  },

  scrapeReviews: function(html, region_code, callback) {
    new com.forward.invisiblehand.amazonReviews(region_code, html).scrape(callback);
  },

  scrape: function(notification, currentPage) {
    var self = this;

    var reviewsCallback = function(scrapeResult) {
      return (function (reviews) {
        if (!reviews.number) return;
        scrapeResult.reviews = reviews;
        notification.sendMessage({alternative: self.helper.toJson(scrapeResult)});
      });
    };

    var scrapingCallback = function(scrapeResult, html) {

      if (self.helper.alternativeScrapeFailed(scrapeResult) || self.helper.isSuspiciouslyCheap(scrapeResult, currentPage.price())) {
        return;
      }
      notification.sendMessage({alternative: self.helper.toJson(scrapeResult)});

      self.scrapeReviews(html, self.retailer.region.code, reviewsCallback(scrapeResult));
      if (currentPage.alternative.shouldFetchRelatedProducts()){
        self.relatedProducts.fetchRelatedProducts(self.url, html, function(relatedProducts) { self.relatedProductsCallback(relatedProducts, notification) } );
      }
    };

    this.browser.getUrl(this.url, this.scrapeHandler(scrapingCallback));
  }

}
com.forward.invisiblehand.alternativeFactory = function (extension, relatedProducts, options) {
  this.extension = extension;
  this.relatedProducts = relatedProducts;
  this.options = options;
}

com.forward.invisiblehand.alternativeFactory.prototype = {

  isAmazonPage: function(url){
    return !!url.match(/www\.amazon\.[a-z.]{2,5}\//i);
  },

  alternativeFor: function(retailer, alternative){
    if(this.isAmazonPage(alternative.scraping_address)) {
      return new com.forward.invisiblehand.amazonAlternative(retailer, alternative, this.extension, this.relatedProducts);
    } else {
      return new com.forward.invisiblehand.alternative(retailer, alternative, this.extension, this.options);
    }
  }

}
com.forward.invisiblehand.upcomingRetailers = function (regions, browser, extension) {
  this.regions = regions;
  this.extension = extension;
  this.browser = browser;
}

com.forward.invisiblehand.upcomingRetailers.prototype = {

  retailers: function(){
    return    [
      {"name":"118golf.co.uk","region":"UK","regex":"^https?://(www\\.)?118golf\\.co\\.uk"},
      {"name":"1800getlens.com","region":"US","regex":"^https?://(www\\.)?1800getlens\\.com"},
      {"name":"1800petmeds.com","region":"US","regex":"^https?://(www\\.)?1800petmeds\\.com"},
      {"name":"1adobe.com","region":"US","regex":"^https?://(www\\.)?1adobe\\.com"},
      {"name":"1staudiovisual.co.uk","region":"UK","regex":"^https?://(www\\.)?1staudiovisual\\.co\\.uk"},
      {"name":"1stinvideoaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?1stinvideoaffiliatetechnology\\.com"},
      {"name":"1stopflorists.com","region":"US","regex":"^https?://(www\\.)?1stopflorists\\.com"},
      {"name":"1stoplighting.com","region":"US","regex":"^https?://(www\\.)?1stoplighting\\.com"},
      {"name":"2adobe.com","region":"UK","regex":"^https?://(www\\.)?2adobe\\.com"},
      {"name":"39dollarglasses.com","region":"US","regex":"^https?://(www\\.)?39dollarglasses\\.com"},
      {"name":"3mselect.co.uk","region":"UK","regex":"^https?://(www\\.)?3mselect\\.co\\.uk"},
      {"name":"4allmemory.com","region":"US","regex":"^https?://(www\\.)?4allmemory\\.com"},
      {"name":"4inkjets.com","region":"US","regex":"^https?://(www\\.)?4inkjets\\.com"},
      {"name":"4wd.com","region":"US","regex":"^https?://(www\\.)?4wd\\.com"},
      {"name":"525america.com","region":"US","regex":"^https?://(www\\.)?525america\\.com"},
      {"name":"6pm.com","region":"US","regex":"^https?://(www\\.)?6pm\\.com"},
      {"name":"7dayshop.com","region":"UK","regex":"^https?://(www\\.)?7dayshop\\.com"},
      {"name":"a1gifts.co.uk","region":"UK","regex":"^https?://(www\\.)?a1gifts\\.co\\.uk"},
      {"name":"aanzee.com","region":"US","regex":"^https?://(www\\.)?aanzee\\.com"},
      {"name":"ab-in-den-urlaub.de","region":"DE","regex":"^https?://(www\\.)?ab-in-den-urlaub\\.de"},
      {"name":"ababy.com","region":"US","regex":"^https?://(www\\.)?ababy\\.com"},
      {"name":"abasaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?abasaffiliatetechnology\\.com"},
      {"name":"abcrugs.com","region":"US","regex":"^https?://(www\\.)?abcrugs\\.com"},
      {"name":"abopool.de","region":"DE","regex":"^https?://(www\\.)?abopool\\.de"},
      {"name":"absolutemusic.co.uk","region":"UK","regex":"^https?://(www\\.)?absolutemusic\\.co\\.uk"},
      {"name":"accessoriesusdell.com","region":"CA","regex":"^https?://(www\\.)?accessoriesusdell\\.com"},
      {"name":"accessorygeeks.com","region":"US","regex":"^https?://(www\\.)?accessorygeeks\\.com"},
      {"name":"accorhotels.com","region":"US","regex":"^https?://(www\\.)?accorhotels\\.com"},
      {"name":"active-srv02.de","region":"DE","regex":"^https?://(www\\.)?active-srv02\\.de"},
      {"name":"activinstinct.com","region":"UK","regex":"^https?://(www\\.)?activinstinct\\.com"},
      {"name":"adagio.com","region":"US","regex":"^https?://(www\\.)?adagio\\.com"},
      {"name":"adamevetoys.com","region":"US","regex":"^https?://(www\\.)?adamevetoys\\.com"},
      {"name":"adfarmmediaplex.com","region":"UK","regex":"^https?://(www\\.)?adfarmmediaplex\\.com"},
      {"name":"adirondackchairs.com","region":"US","regex":"^https?://(www\\.)?adirondackchairs\\.com"},
      {"name":"advancedmp3players.co.uk","region":"UK","regex":"^https?://(www\\.)?advancedmp3players\\.co\\.uk"},
      {"name":"affiliatewindowbe-direct.co.uk","region":"UK","regex":"^https?://(www\\.)?affiliatewindowbe-direct\\.co\\.uk"},
      {"name":"afflictionclothingstore.com","region":"US","regex":"^https?://(www\\.)?afflictionclothingstore\\.com"},
      {"name":"afrostore.biz","region":"US","regex":"^https?://(www\\.)?afrostore\\.biz"},
      {"name":"afterglowcosmetics.com","region":"US","regex":"^https?://(www\\.)?afterglowcosmetics\\.com"},
      {"name":"agentprovocateur.com","region":"UK","regex":"^https?://(www\\.)?agentprovocateur\\.com"},
      {"name":"ahavaus.com","region":"US","regex":"^https?://(www\\.)?ahavaus\\.com"},
      {"name":"aircondirect.co.uk","region":"UK","regex":"^https?://(www\\.)?aircondirect\\.co\\.uk"},
      {"name":"akademiks.com","region":"US","regex":"^https?://(www\\.)?akademiks\\.com"},
      {"name":"albamoda.de","region":"DE","regex":"^https?://(www\\.)?albamoda\\.de"},
      {"name":"aldiana.de","region":"DE","regex":"^https?://(www\\.)?aldiana\\.de"},
      {"name":"alessi.de","region":"DE","regex":"^https?://(www\\.)?alessi\\.de"},
      {"name":"aliexpress.com","region":"US","regex":"^https?://(www\\.)?aliexpress\\.com"},
      {"name":"alight.com","region":"US","regex":"^https?://(www\\.)?alight\\.com"},
      {"name":"aliva.de","region":"DE","regex":"^https?://(www\\.)?aliva\\.de"},
      {"name":"all-battery.com","region":"US","regex":"^https?://(www\\.)?all-battery\\.com"},
      {"name":"all4cellular.com","region":"US","regex":"^https?://(www\\.)?all4cellular\\.com"},
      {"name":"allikestore.com","region":"UK","regex":"^https?://(www\\.)?allikestore\\.com"},
      {"name":"allposters.com","region":"US","regex":"^https?://(www\\.)?allposters\\.com"},
      {"name":"allupandon.co.uk","region":"UK","regex":"^https?://(www\\.)?allupandon\\.co\\.uk"},
      {"name":"allurez.com","region":"US","regex":"^https?://(www\\.)?allurez\\.com"},
      {"name":"alpharooms.com","region":"UK","regex":"^https?://(www\\.)?alpharooms\\.com"},
      {"name":"amansis.de","region":"US","regex":"^https?://(www\\.)?amansis\\.de"},
      {"name":"amapur.de","region":"DE","regex":"^https?://(www\\.)?amapur\\.de"},
      {"name":"amerimark.com","region":"US","regex":"^https?://(www\\.)?amerimark\\.com"},
      {"name":"amiclubwear.com","region":"US","regex":"^https?://(www\\.)?amiclubwear\\.com"},
      {"name":"amoro.com","region":"US","regex":"^https?://(www\\.)?amoro\\.com"},
      {"name":"andysautosport.com","region":"US","regex":"^https?://(www\\.)?andysautosport\\.com"},
      {"name":"animalden.com","region":"US","regex":"^https?://(www\\.)?animalden\\.com"},
      {"name":"annaslinens.com","region":"US","regex":"^https?://(www\\.)?annaslinens\\.com"},
      {"name":"anonstoppartner.net","region":"US","regex":"^https?://(www\\.)?anonstoppartner\\.net"},
      {"name":"apartstyle.com","region":"US","regex":"^https?://(www\\.)?apartstyle\\.com"},
      {"name":"aphrobridal.com","region":"US","regex":"^https?://(www\\.)?aphrobridal\\.com"},
      {"name":"aphrodite-dessous.de","region":"US","regex":"^https?://(www\\.)?aphrodite-dessous\\.de"},
      {"name":"apmex.com","region":"US","regex":"^https?://(www\\.)?apmex\\.com"},
      {"name":"apothekemedipolis.de","region":"DE","regex":"^https?://(www\\.)?apothekemedipolis\\.de"},
      {"name":"applebottoms.com","region":"US","regex":"^https?://(www\\.)?applebottoms\\.com"},
      {"name":"applesofgold.com","region":"US","regex":"^https?://(www\\.)?applesofgold\\.com"},
      {"name":"appliancecity.co.uk","region":"UK","regex":"^https?://(www\\.)?appliancecity\\.co\\.uk"},
      {"name":"aqua-pond24.de","region":"US","regex":"^https?://(www\\.)?aqua-pond24\\.de"},
      {"name":"aquaristikshop.com","region":"US","regex":"^https?://(www\\.)?aquaristikshop\\.com"},
      {"name":"aquarterof.co.uk","region":"UK","regex":"^https?://(www\\.)?aquarterof\\.co\\.uk"},
      {"name":"arcadeboutique.com","region":"US","regex":"^https?://(www\\.)?arcadeboutique\\.com"},
      {"name":"arenaflowers.com","region":"UK","regex":"^https?://(www\\.)?arenaflowers\\.com"},
      {"name":"argento.co.uk","region":"UK","regex":"^https?://(www\\.)?argento\\.co\\.uk"},
      {"name":"arlt.com","region":"DE","regex":"^https?://(www\\.)?arlt\\.com"},
      {"name":"art.co.uk","region":"US","regex":"^https?://(www\\.)?art\\.co\\.uk"},
      {"name":"artbox.co.uk","region":"UK","regex":"^https?://(www\\.)?artbox\\.co\\.uk"},
      {"name":"artisticchecks.com","region":"US","regex":"^https?://(www\\.)?artisticchecks\\.com"},
      {"name":"artrepublic.com","region":"UK","regex":"^https?://(www\\.)?artrepublic\\.com"},
      {"name":"asos.de","region":"DE","regex":"^https?://(www\\.)?asos\\.de"},
      {"name":"asoya.com","region":"US","regex":"^https?://(www\\.)?asoya\\.com"},
      {"name":"aspinaloflondon.com","region":"US","regex":"^https?://(www\\.)?aspinaloflondon\\.com"},
      {"name":"asseenontv.com","region":"US","regex":"^https?://(www\\.)?asseenontv\\.com"},
      {"name":"aswechange.com","region":"US","regex":"^https?://(www\\.)?aswechange\\.com"},
      {"name":"atomic-clock.org.uk","region":"UK","regex":"^https?://(www\\.)?atomic-clock\\.org\\.uk"},
      {"name":"attractiontix.co.uk","region":"UK","regex":"^https?://(www\\.)?attractiontix\\.co\\.uk"},
      {"name":"atu.de","region":"DE","regex":"^https?://(www\\.)?atu\\.de"},
      {"name":"audible.de","region":"DE","regex":"^https?://(www\\.)?audible\\.de"},
      {"name":"austinreed.co.uk","region":"UK","regex":"^https?://(www\\.)?austinreed\\.co\\.uk"},
      {"name":"autohausaz.com","region":"US","regex":"^https?://(www\\.)?autohausaz\\.com"},
      {"name":"autoteiletrend.de","region":"DE","regex":"^https?://(www\\.)?autoteiletrend\\.de"},
      {"name":"aviracleverbridge.com","region":"DE","regex":"^https?://(www\\.)?aviracleverbridge\\.com"},
      {"name":"aviracleverbridge.com","region":"US","regex":"^https?://(www\\.)?aviracleverbridge\\.com"},
      {"name":"avonshop.co.uk","region":"UK","regex":"^https?://(www\\.)?avonshop\\.co\\.uk"},
      {"name":"awnacobe-direct.co.uk","region":"UK","regex":"^https?://(www\\.)?awnacobe-direct\\.co\\.uk"},
      {"name":"ayyildiz.de","region":"DE","regex":"^https?://(www\\.)?ayyildiz\\.de"},
      {"name":"babymonitorsdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?babymonitorsdirect\\.co\\.uk"},
      {"name":"babyphat.com","region":"US","regex":"^https?://(www\\.)?babyphat\\.com"},
      {"name":"babyshop.de","region":"US","regex":"^https?://(www\\.)?babyshop\\.de"},
      {"name":"baden-baden-weinshop.de","region":"DE","regex":"^https?://(www\\.)?baden-baden-weinshop\\.de"},
      {"name":"baerbel-drexel.com","region":"DE","regex":"^https?://(www\\.)?baerbel-drexel\\.com"},
      {"name":"bagborroworsteal.com","region":"US","regex":"^https?://(www\\.)?bagborroworsteal\\.com"},
      {"name":"bagsdirect.com","region":"UK","regex":"^https?://(www\\.)?bagsdirect\\.com"},
      {"name":"bakerross.co.uk","region":"UK","regex":"^https?://(www\\.)?bakerross\\.co\\.uk"},
      {"name":"balbina-balbina.de","region":"DE","regex":"^https?://(www\\.)?balbina-balbina\\.de"},
      {"name":"baldur-garten.de","region":"DE","regex":"^https?://(www\\.)?baldur-garten\\.de"},
      {"name":"bananarepublic.com","region":"US","regex":"^https?://(www\\.)?bananarepublic\\.com"},
      {"name":"bananarepublicgap.com","region":"US","regex":"^https?://(www\\.)?bananarepublicgap\\.com"},
      {"name":"banglads.com","region":"UK","regex":"^https?://(www\\.)?banglads\\.com"},
      {"name":"bankfashion.co.uk","region":"UK","regex":"^https?://(www\\.)?bankfashion\\.co\\.uk"},
      {"name":"bannernonstoppartner.de","region":"DE","regex":"^https?://(www\\.)?bannernonstoppartner\\.de"},
      {"name":"barenecessities.com","region":"US","regex":"^https?://(www\\.)?barenecessities\\.com"},
      {"name":"bargaincrazy.com","region":"UK","regex":"^https?://(www\\.)?bargaincrazy\\.com"},
      {"name":"barkerandstonehouse.co.uk","region":"UK","regex":"^https?://(www\\.)?barkerandstonehouse\\.co\\.uk"},
      {"name":"barmans.co.uk","region":"UK","regex":"^https?://(www\\.)?barmans\\.co\\.uk"},
      {"name":"barratts.co.uk","region":"UK","regex":"^https?://(www\\.)?barratts\\.co\\.uk"},
      {"name":"barstoolsaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?barstoolsaffiliatetechnology\\.com"},
      {"name":"base.de","region":"DE","regex":"^https?://(www\\.)?base\\.de"},
      {"name":"baselondon.com","region":"UK","regex":"^https?://(www\\.)?baselondon\\.com"},
      {"name":"bastelundhobbykiste.de","region":"DE","regex":"^https?://(www\\.)?bastelundhobbykiste\\.de"},
      {"name":"batesfootwear.com","region":"US","regex":"^https?://(www\\.)?batesfootwear\\.com"},
      {"name":"bathrooms.com","region":"UK","regex":"^https?://(www\\.)?bathrooms\\.com"},
      {"name":"baumschule-horstmann.de","region":"DE","regex":"^https?://(www\\.)?baumschule-horstmann\\.de"},
      {"name":"bbcamericashop.com","region":"US","regex":"^https?://(www\\.)?bbcamericashop\\.com"},
      {"name":"bbccanadashop.com","region":"CA","regex":"^https?://(www\\.)?bbccanadashop\\.com"},
      {"name":"bbclothing.co.uk","region":"UK","regex":"^https?://(www\\.)?bbclothing\\.co\\.uk"},
      {"name":"bbq-shop24.de","region":"DE","regex":"^https?://(www\\.)?bbq-shop24\\.de"},
      {"name":"beachfashionshop.com","region":"DE","regex":"^https?://(www\\.)?beachfashionshop\\.com"},
      {"name":"beallsflorida.com","region":"US","regex":"^https?://(www\\.)?beallsflorida\\.com"},
      {"name":"beamer-discount.de","region":"US","regex":"^https?://(www\\.)?beamer-discount\\.de"},
      {"name":"beautiesltd.com","region":"US","regex":"^https?://(www\\.)?beautiesltd\\.com"},
      {"name":"beautorium.com","region":"US","regex":"^https?://(www\\.)?beautorium\\.com"},
      {"name":"beauty-training.co.uk","region":"UK","regex":"^https?://(www\\.)?beauty-training\\.co\\.uk"},
      {"name":"beautybridge.com","region":"US","regex":"^https?://(www\\.)?beautybridge\\.com"},
      {"name":"beautyintuitionaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?beautyintuitionaffiliatetechnology\\.com"},
      {"name":"beautyneeds.com","region":"US","regex":"^https?://(www\\.)?beautyneeds\\.com"},
      {"name":"beautynet.de","region":"DE","regex":"^https?://(www\\.)?beautynet\\.de"},
      {"name":"beautysleuth.co.uk","region":"UK","regex":"^https?://(www\\.)?beautysleuth\\.co\\.uk"},
      {"name":"bebeaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?bebeaffiliatetechnology\\.com"},
      {"name":"bedbathstore.com","region":"US","regex":"^https?://(www\\.)?bedbathstore\\.com"},
      {"name":"beddingstyle.com","region":"US","regex":"^https?://(www\\.)?beddingstyle\\.com"},
      {"name":"bedfordfair.com","region":"US","regex":"^https?://(www\\.)?bedfordfair\\.com"},
      {"name":"bedheadpjs.com","region":"US","regex":"^https?://(www\\.)?bedheadpjs\\.com"},
      {"name":"bedman.co.uk","region":"UK","regex":"^https?://(www\\.)?bedman\\.co\\.uk"},
      {"name":"bedstar.co.uk","region":"UK","regex":"^https?://(www\\.)?bedstar\\.co\\.uk"},
      {"name":"bedtimeflirt.com","region":"UK","regex":"^https?://(www\\.)?bedtimeflirt\\.com"},
      {"name":"belboon.de","region":"US","regex":"^https?://(www\\.)?belboon\\.de"},
      {"name":"beleuchtungszentrum.de","region":"DE","regex":"^https?://(www\\.)?beleuchtungszentrum\\.de"},
      {"name":"beltronics.com","region":"US","regex":"^https?://(www\\.)?beltronics\\.com"},
      {"name":"bench.co.uk","region":"UK","regex":"^https?://(www\\.)?bench\\.co\\.uk"},
      {"name":"bennyblu.de","region":"DE","regex":"^https?://(www\\.)?bennyblu\\.de"},
      {"name":"benshermanusa.com","region":"US","regex":"^https?://(www\\.)?benshermanusa\\.com"},
      {"name":"best4glasses.co.uk","region":"UK","regex":"^https?://(www\\.)?best4glasses\\.co\\.uk"},
      {"name":"bestbullysticks.com","region":"US","regex":"^https?://(www\\.)?bestbullysticks\\.com"},
      {"name":"bestofferbuy.com","region":"US","regex":"^https?://(www\\.)?bestofferbuy\\.com"},
      {"name":"betreut.de","region":"DE","regex":"^https?://(www\\.)?betreut\\.de"},
      {"name":"betten-braun.de","region":"DE","regex":"^https?://(www\\.)?betten-braun\\.de"},
      {"name":"bettenrid.de","region":"DE","regex":"^https?://(www\\.)?bettenrid\\.de"},
      {"name":"betterwesternwear.de","region":"DE","regex":"^https?://(www\\.)?betterwesternwear\\.de"},
      {"name":"bewild.com","region":"US","regex":"^https?://(www\\.)?bewild\\.com"},
      {"name":"beyondtelevision.co.uk","region":"UK","regex":"^https?://(www\\.)?beyondtelevision\\.co\\.uk"},
      {"name":"bhsmenswear.co.uk","region":"UK","regex":"^https?://(www\\.)?bhsmenswear\\.co\\.uk"},
      {"name":"bigalsonlineaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?bigalsonlineaffiliatetechnology\\.com"},
      {"name":"bigdogs.com","region":"US","regex":"^https?://(www\\.)?bigdogs\\.com"},
      {"name":"bigfishgames.com","region":"US","regex":"^https?://(www\\.)?bigfishgames\\.com"},
      {"name":"bigfitness.com","region":"US","regex":"^https?://(www\\.)?bigfitness\\.com"},
      {"name":"bigoutlet.com","region":"US","regex":"^https?://(www\\.)?bigoutlet\\.com"},
      {"name":"bigredwarehouse.co.uk","region":"UK","regex":"^https?://(www\\.)?bigredwarehouse\\.co\\.uk"},
      {"name":"bike-mailorder.de","region":"DE","regex":"^https?://(www\\.)?bike-mailorder\\.de"},
      {"name":"bikewwworld.de","region":"DE","regex":"^https?://(www\\.)?bikewwworld\\.de"},
      {"name":"bildmobil.de","region":"DE","regex":"^https?://(www\\.)?bildmobil\\.de"},
      {"name":"bioverum.de","region":"DE","regex":"^https?://(www\\.)?bioverum\\.de"},
      {"name":"biquini-brasil.com","region":"DE","regex":"^https?://(www\\.)?biquini-brasil\\.com"},
      {"name":"birdfeeders.com","region":"US","regex":"^https?://(www\\.)?birdfeeders\\.com"},
      {"name":"bizzyballoonsf2s.com","region":"UK","regex":"^https?://(www\\.)?bizzyballoonsf2s\\.com"},
      {"name":"bjornborg.com","region":"US","regex":"^https?://(www\\.)?bjornborg\\.com"},
      {"name":"blackexpressions.com","region":"US","regex":"^https?://(www\\.)?blackexpressions\\.com"},
      {"name":"blacks.co.uk","region":"UK","regex":"^https?://(www\\.)?blacks\\.co\\.uk"},
      {"name":"blair.com","region":"US","regex":"^https?://(www\\.)?blair\\.com"},
      {"name":"blindsaver.com","region":"US","regex":"^https?://(www\\.)?blindsaver\\.com"},
      {"name":"blindsexpress.com","region":"US","regex":"^https?://(www\\.)?blindsexpress\\.com"},
      {"name":"blindsgalore.com","region":"US","regex":"^https?://(www\\.)?blindsgalore\\.com"},
      {"name":"blinkbox.com","region":"UK","regex":"^https?://(www\\.)?blinkbox\\.com"},
      {"name":"blissworld.com","region":"US","regex":"^https?://(www\\.)?blissworld\\.com"},
      {"name":"bloomingdirect.com","region":"UK","regex":"^https?://(www\\.)?bloomingdirect\\.com"},
      {"name":"blue-tomato.com","region":"US","regex":"^https?://(www\\.)?blue-tomato\\.com"},
      {"name":"blueinc.co.uk","region":"UK","regex":"^https?://(www\\.)?blueinc\\.co\\.uk"},
      {"name":"bluenile.co.uk","region":"UK","regex":"^https?://(www\\.)?bluenile\\.co\\.uk"},
      {"name":"blume2000.de","region":"DE","regex":"^https?://(www\\.)?blume2000\\.de"},
      {"name":"blumenshop.cc","region":"DE","regex":"^https?://(www\\.)?blumenshop\\.cc"},
      {"name":"boc24.de","region":"DE","regex":"^https?://(www\\.)?boc24\\.de"},
      {"name":"boden.co.uk","region":"UK","regex":"^https?://(www\\.)?boden\\.co\\.uk"},
      {"name":"bodhishop.ca","region":"CA","regex":"^https?://(www\\.)?bodhishop\\.ca"},
      {"name":"bodhishop.com","region":"US","regex":"^https?://(www\\.)?bodhishop\\.com"},
      {"name":"bodycandy.com","region":"US","regex":"^https?://(www\\.)?bodycandy\\.com"},
      {"name":"bodyguardapotheke.com","region":"US","regex":"^https?://(www\\.)?bodyguardapotheke\\.com"},
      {"name":"bogner.com","region":"US","regex":"^https?://(www\\.)?bogner\\.com"},
      {"name":"bombayduck.co.uk","region":"UK","regex":"^https?://(www\\.)?bombayduck\\.co\\.uk"},
      {"name":"bomc2.com","region":"US","regex":"^https?://(www\\.)?bomc2\\.com"},
      {"name":"bomcclub.com","region":"US","regex":"^https?://(www\\.)?bomcclub\\.com"},
      {"name":"bonprix.de","region":"DE","regex":"^https?://(www\\.)?bonprix\\.de"},
      {"name":"bonsaiboy.com","region":"US","regex":"^https?://(www\\.)?bonsaiboy\\.com"},
      {"name":"boohoo.com","region":"UK","regex":"^https?://(www\\.)?boohoo\\.com"},
      {"name":"bookcloseouts.com","region":"US","regex":"^https?://(www\\.)?bookcloseouts\\.com"},
      {"name":"bookingswiss.com","region":"US","regex":"^https?://(www\\.)?bookingswiss\\.com"},
      {"name":"bookrenter.com","region":"US","regex":"^https?://(www\\.)?bookrenter\\.com"},
      {"name":"borngifted.co.uk","region":"UK","regex":"^https?://(www\\.)?borngifted\\.co\\.uk"},
      {"name":"bottegaverde.de","region":"DE","regex":"^https?://(www\\.)?bottegaverde\\.de"},
      {"name":"boutiquetoyou.com","region":"UK","regex":"^https?://(www\\.)?boutiquetoyou\\.com"},
      {"name":"boutiquetoyou.com","region":"US","regex":"^https?://(www\\.)?boutiquetoyou\\.com"},
      {"name":"branch309.co.uk","region":"UK","regex":"^https?://(www\\.)?branch309\\.co\\.uk"},
      {"name":"brandos.de","region":"DE","regex":"^https?://(www\\.)?brandos\\.de"},
      {"name":"brennands.co.uk","region":"US","regex":"^https?://(www\\.)?brennands\\.co\\.uk"},
      {"name":"brenthavenaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?brenthavenaffiliatetechnology\\.com"},
      {"name":"breuninger.com","region":"US","regex":"^https?://(www\\.)?breuninger\\.com"},
      {"name":"bright-britain.de","region":"US","regex":"^https?://(www\\.)?bright-britain\\.de"},
      {"name":"bringmirbio.de","region":"DE","regex":"^https?://(www\\.)?bringmirbio\\.de"},
      {"name":"brio-shop.de","region":"DE","regex":"^https?://(www\\.)?brio-shop\\.de"},
      {"name":"brooktaverner.co.uk","region":"UK","regex":"^https?://(www\\.)?brooktaverner\\.co\\.uk"},
      {"name":"brownells.com","region":"US","regex":"^https?://(www\\.)?brownells\\.com"},
      {"name":"bsb-shop24.de","region":"US","regex":"^https?://(www\\.)?bsb-shop24\\.de"},
      {"name":"bucher-reisen.de","region":"DE","regex":"^https?://(www\\.)?bucher-reisen\\.de"},
      {"name":"budovideos.com","region":"US","regex":"^https?://(www\\.)?budovideos\\.com"},
      {"name":"buero-discounter.de","region":"DE","regex":"^https?://(www\\.)?buero-discounter\\.de"},
      {"name":"buerostuhl24.com","region":"US","regex":"^https?://(www\\.)?buerostuhl24\\.com"},
      {"name":"buffaloshop.de","region":"DE","regex":"^https?://(www\\.)?buffaloshop\\.de"},
      {"name":"bulbby.de","region":"DE","regex":"^https?://(www\\.)?bulbby\\.de"},
      {"name":"bulkofficesupply.com","region":"US","regex":"^https?://(www\\.)?bulkofficesupply\\.com"},
      {"name":"bunches.co.uk","region":"UK","regex":"^https?://(www\\.)?bunches\\.co\\.uk"},
      {"name":"buntefuesse.de","region":"DE","regex":"^https?://(www\\.)?buntefuesse\\.de"},
      {"name":"burkedecor.com","region":"US","regex":"^https?://(www\\.)?burkedecor\\.com"},
      {"name":"burner.de","region":"DE","regex":"^https?://(www\\.)?burner\\.de"},
      {"name":"burton.co.uk","region":"UK","regex":"^https?://(www\\.)?burton\\.co\\.uk"},
      {"name":"businessplanpro.com","region":"US","regex":"^https?://(www\\.)?businessplanpro\\.com"},
      {"name":"bustedtees.com","region":"US","regex":"^https?://(www\\.)?bustedtees\\.com"},
      {"name":"buyagift.co.uk","region":"UK","regex":"^https?://(www\\.)?buyagift\\.co\\.uk"},
      {"name":"buyandwalk.com","region":"US","regex":"^https?://(www\\.)?buyandwalk\\.com"},
      {"name":"buyawardsandtrophies.com","region":"US","regex":"^https?://(www\\.)?buyawardsandtrophies\\.com"},
      {"name":"buygarmin.com","region":"US","regex":"^https?://(www\\.)?buygarmin\\.com"},
      {"name":"buynorton.com","region":"CA","regex":"^https?://(www\\.)?buynorton\\.com"},
      {"name":"buynowornever.com","region":"US","regex":"^https?://(www\\.)?buynowornever\\.com"},
      {"name":"buyrugdoctor.com","region":"US","regex":"^https?://(www\\.)?buyrugdoctor\\.com"},
      {"name":"buywithme.com","region":"US","regex":"^https?://(www\\.)?buywithme\\.com"},
      {"name":"cadburygiftsdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?cadburygiftsdirect\\.co\\.uk"},
      {"name":"cafebritt.com","region":"US","regex":"^https?://(www\\.)?cafebritt\\.com"},
      {"name":"calendars.com","region":"US","regex":"^https?://(www\\.)?calendars\\.com"},
      {"name":"callawaygolfpreowned.com","region":"US","regex":"^https?://(www\\.)?callawaygolfpreowned\\.com"},
      {"name":"callpod.com","region":"US","regex":"^https?://(www\\.)?callpod\\.com"},
      {"name":"campdavid-shop.de","region":"DE","regex":"^https?://(www\\.)?campdavid-shop\\.de"},
      {"name":"canadafrenchconnection.com","region":"US","regex":"^https?://(www\\.)?canadafrenchconnection\\.com"},
      {"name":"candlebay.com","region":"US","regex":"^https?://(www\\.)?candlebay\\.com"},
      {"name":"candy.com","region":"US","regex":"^https?://(www\\.)?candy\\.com"},
      {"name":"candydirect.com","region":"US","regex":"^https?://(www\\.)?candydirect\\.com"},
      {"name":"canvasondemand.com","region":"US","regex":"^https?://(www\\.)?canvasondemand\\.com"},
      {"name":"capuniverse.de","region":"DE","regex":"^https?://(www\\.)?capuniverse\\.de"},
      {"name":"carlosshoes.com","region":"US","regex":"^https?://(www\\.)?carlosshoes\\.com"},
      {"name":"carolee.com","region":"US","regex":"^https?://(www\\.)?carolee\\.com"},
      {"name":"carolwrightgifts.com","region":"US","regex":"^https?://(www\\.)?carolwrightgifts\\.com"},
      {"name":"carouselchecks.com","region":"US","regex":"^https?://(www\\.)?carouselchecks\\.com"},
      {"name":"carparts.com","region":"US","regex":"^https?://(www\\.)?carparts\\.com"},
      {"name":"carphonewarehouse.com","region":"UK","regex":"^https?://(www\\.)?carphonewarehouse\\.com"},
      {"name":"cartridgemonkey.com","region":"UK","regex":"^https?://(www\\.)?cartridgemonkey\\.com"},
      {"name":"caselogic.com","region":"US","regex":"^https?://(www\\.)?caselogic\\.com"},
      {"name":"cashmereboutique.com","region":"US","regex":"^https?://(www\\.)?cashmereboutique\\.com"},
      {"name":"casioonline.co.uk","region":"UK","regex":"^https?://(www\\.)?casioonline\\.co\\.uk"},
      {"name":"castinstyle.co.uk","region":"UK","regex":"^https?://(www\\.)?castinstyle\\.co\\.uk"},
      {"name":"catfootwear.com","region":"US","regex":"^https?://(www\\.)?catfootwear\\.com"},
      {"name":"cathkidston.co.uk","region":"UK","regex":"^https?://(www\\.)?cathkidston\\.co\\.uk"},
      {"name":"catholiccompany.com","region":"US","regex":"^https?://(www\\.)?catholiccompany\\.com"},
      {"name":"catrun-shop.de","region":"DE","regex":"^https?://(www\\.)?catrun-shop\\.de"},
      {"name":"cbomc.com","region":"US","regex":"^https?://(www\\.)?cbomc\\.com"},
      {"name":"cbsseenon.com","region":"US","regex":"^https?://(www\\.)?cbsseenon\\.com"},
      {"name":"ccbparis.de","region":"DE","regex":"^https?://(www\\.)?ccbparis\\.de"},
      {"name":"ccfashion.co.uk","region":"UK","regex":"^https?://(www\\.)?ccfashion\\.co\\.uk"},
      {"name":"cellarandkitchenadnams.co.uk","region":"UK","regex":"^https?://(www\\.)?cellarandkitchenadnams\\.co\\.uk"},
      {"name":"cellhub.com","region":"US","regex":"^https?://(www\\.)?cellhub\\.com"},
      {"name":"cellphoneaccents.com","region":"US","regex":"^https?://(www\\.)?cellphoneaccents\\.com"},
      {"name":"cellphoneshop.net","region":"US","regex":"^https?://(www\\.)?cellphoneshop\\.net"},
      {"name":"celtichills.com","region":"US","regex":"^https?://(www\\.)?celtichills\\.com"},
      {"name":"celticsstoreseenon.com","region":"US","regex":"^https?://(www\\.)?celticsstoreseenon\\.com"},
      {"name":"cengagebrain.com","region":"US","regex":"^https?://(www\\.)?cengagebrain\\.com"},
      {"name":"cgdiscountgolf.co.uk","region":"UK","regex":"^https?://(www\\.)?cgdiscountgolf\\.co\\.uk"},
      {"name":"chacos.com","region":"US","regex":"^https?://(www\\.)?chacos\\.com"},
      {"name":"chainreactioncycles.com","region":"UK","regex":"^https?://(www\\.)?chainreactioncycles\\.com"},
      {"name":"championusa.com","region":"US","regex":"^https?://(www\\.)?championusa\\.com"},
      {"name":"champire.de","region":"DE","regex":"^https?://(www\\.)?champire\\.de"},
      {"name":"chappellofbondstreet.co.uk","region":"UK","regex":"^https?://(www\\.)?chappellofbondstreet\\.co\\.uk"},
      {"name":"character-online.com","region":"UK","regex":"^https?://(www\\.)?character-online\\.com"},
      {"name":"chargrilled.co.uk","region":"UK","regex":"^https?://(www\\.)?chargrilled\\.co\\.uk"},
      {"name":"cheapsmells.com","region":"UK","regex":"^https?://(www\\.)?cheapsmells\\.com"},
      {"name":"cheapsuites.co.uk","region":"UK","regex":"^https?://(www\\.)?cheapsuites\\.co\\.uk"},
      {"name":"chicstar.com","region":"US","regex":"^https?://(www\\.)?chicstar\\.com"},
      {"name":"chocolatetradingco.com","region":"UK","regex":"^https?://(www\\.)?chocolatetradingco\\.com"},
      {"name":"chocri.de","region":"DE","regex":"^https?://(www\\.)?chocri\\.de"},
      {"name":"christiangear.com","region":"US","regex":"^https?://(www\\.)?christiangear\\.com"},
      {"name":"citysightsny.com","region":"US","regex":"^https?://(www\\.)?citysightsny\\.com"},
      {"name":"cj.com","region":"US","regex":"^https?://(www\\.)?cj\\.com"},
      {"name":"clareflorist.co.uk","region":"UK","regex":"^https?://(www\\.)?clareflorist\\.co\\.uk"},
      {"name":"cleanbot.de","region":"US","regex":"^https?://(www\\.)?cleanbot\\.de"},
      {"name":"clickgolf.co.uk","region":"UK","regex":"^https?://(www\\.)?clickgolf\\.co\\.uk"},
      {"name":"clickinks.com","region":"US","regex":"^https?://(www\\.)?clickinks\\.com"},
      {"name":"clicklinksynergy.com","region":"US","regex":"^https?://(www\\.)?clicklinksynergy\\.com"},
      {"name":"clifford-james.co.uk","region":"UK","regex":"^https?://(www\\.)?clifford-james\\.co\\.uk"},
      {"name":"cloggs.co.uk","region":"UK","regex":"^https?://(www\\.)?cloggs\\.co\\.uk"},
      {"name":"closeup.de","region":"US","regex":"^https?://(www\\.)?closeup\\.de"},
      {"name":"clothesbuy.com","region":"US","regex":"^https?://(www\\.)?clothesbuy\\.com"},
      {"name":"cloud9living.com","region":"US","regex":"^https?://(www\\.)?cloud9living\\.com"},
      {"name":"clubmosaico.com","region":"US","regex":"^https?://(www\\.)?clubmosaico\\.com"},
      {"name":"cmsnl.com","region":"DE","regex":"^https?://(www\\.)?cmsnl\\.com"},
      {"name":"cnkdirect.de","region":"US","regex":"^https?://(www\\.)?cnkdirect\\.de"},
      {"name":"coast-stores.com","region":"UK","regex":"^https?://(www\\.)?coast-stores\\.com"},
      {"name":"coastandcountry.co.uk","region":"UK","regex":"^https?://(www\\.)?coastandcountry\\.co\\.uk"},
      {"name":"cocktailstar.de","region":"US","regex":"^https?://(www\\.)?cocktailstar\\.de"},
      {"name":"coffeesofhawaii.com","region":"US","regex":"^https?://(www\\.)?coffeesofhawaii\\.com"},
      {"name":"combatready.de","region":"DE","regex":"^https?://(www\\.)?combatready\\.de"},
      {"name":"compandsave.com","region":"US","regex":"^https?://(www\\.)?compandsave\\.com"},
      {"name":"condor.com","region":"US","regex":"^https?://(www\\.)?condor\\.com"},
      {"name":"configureeurodell.com","region":"US","regex":"^https?://(www\\.)?configureeurodell\\.com"},
      {"name":"consolesandgadgets.co.uk","region":"UK","regex":"^https?://(www\\.)?consolesandgadgets\\.co\\.uk"},
      {"name":"consumersmarine.com","region":"US","regex":"^https?://(www\\.)?consumersmarine\\.com"},
      {"name":"contactsamerica.com","region":"US","regex":"^https?://(www\\.)?contactsamerica\\.com"},
      {"name":"cookelani.de","region":"DE","regex":"^https?://(www\\.)?cookelani\\.de"},
      {"name":"copiersupplystore.com","region":"US","regex":"^https?://(www\\.)?copiersupplystore\\.com"},
      {"name":"cordless-phonesuk.com","region":"UK","regex":"^https?://(www\\.)?cordless-phonesuk\\.com"},
      {"name":"corel.com","region":"US","regex":"^https?://(www\\.)?corel\\.com"},
      {"name":"cornerstorkbabygifts.com","region":"US","regex":"^https?://(www\\.)?cornerstorkbabygifts\\.com"},
      {"name":"corsoscookies.com","region":"US","regex":"^https?://(www\\.)?corsoscookies\\.com"},
      {"name":"cosme-de.com","region":"US","regex":"^https?://(www\\.)?cosme-de\\.com"},
      {"name":"cosmedix.com","region":"US","regex":"^https?://(www\\.)?cosmedix\\.com"},
      {"name":"costumecity.com","region":"US","regex":"^https?://(www\\.)?costumecity\\.com"},
      {"name":"coursesmart.com","region":"US","regex":"^https?://(www\\.)?coursesmart\\.com"},
      {"name":"couturecandy.com","region":"US","regex":"^https?://(www\\.)?couturecandy\\.com"},
      {"name":"coveroo.com","region":"US","regex":"^https?://(www\\.)?coveroo\\.com"},
      {"name":"cowardshoe.com","region":"US","regex":"^https?://(www\\.)?cowardshoe\\.com"},
      {"name":"cowboom.com","region":"US","regex":"^https?://(www\\.)?cowboom\\.com"},
      {"name":"cpobd.com","region":"US","regex":"^https?://(www\\.)?cpobd\\.com"},
      {"name":"cpobostitch.com","region":"US","regex":"^https?://(www\\.)?cpobostitch\\.com"},
      {"name":"cpocampbellhausfeld.com","region":"US","regex":"^https?://(www\\.)?cpocampbellhausfeld\\.com"},
      {"name":"cpodeltatruckboxes.com","region":"US","regex":"^https?://(www\\.)?cpodeltatruckboxes\\.com"},
      {"name":"cpoelectrolux.com","region":"US","regex":"^https?://(www\\.)?cpoelectrolux\\.com"},
      {"name":"cpofein.com","region":"US","regex":"^https?://(www\\.)?cpofein\\.com"},
      {"name":"cpofestool.com","region":"US","regex":"^https?://(www\\.)?cpofestool\\.com"},
      {"name":"cpohomelite.com","region":"US","regex":"^https?://(www\\.)?cpohomelite\\.com"},
      {"name":"cpohunterfan.com","region":"US","regex":"^https?://(www\\.)?cpohunterfan\\.com"},
      {"name":"cpoindustrialpowertools.com","region":"US","regex":"^https?://(www\\.)?cpoindustrialpowertools\\.com"},
      {"name":"cpojettools.com","region":"US","regex":"^https?://(www\\.)?cpojettools\\.com"},
      {"name":"cpometabo.com","region":"US","regex":"^https?://(www\\.)?cpometabo\\.com"},
      {"name":"cpomilwaukee.com","region":"US","regex":"^https?://(www\\.)?cpomilwaukee\\.com"},
      {"name":"cpopowermatic.com","region":"US","regex":"^https?://(www\\.)?cpopowermatic\\.com"},
      {"name":"cpopowertools.com","region":"US","regex":"^https?://(www\\.)?cpopowertools\\.com"},
      {"name":"cpopressurewashers.com","region":"US","regex":"^https?://(www\\.)?cpopressurewashers\\.com"},
      {"name":"cpoprotools.com","region":"US","regex":"^https?://(www\\.)?cpoprotools\\.com"},
      {"name":"cporotarytools.com","region":"US","regex":"^https?://(www\\.)?cporotarytools\\.com"},
      {"name":"cporyobi.com","region":"US","regex":"^https?://(www\\.)?cporyobi\\.com"},
      {"name":"cposenco.com","region":"US","regex":"^https?://(www\\.)?cposenco\\.com"},
      {"name":"cpotanklesswaterheaters.com","region":"US","regex":"^https?://(www\\.)?cpotanklesswaterheaters\\.com"},
      {"name":"cpoworkshop.com","region":"US","regex":"^https?://(www\\.)?cpoworkshop\\.com"},
      {"name":"cptoy.com","region":"US","regex":"^https?://(www\\.)?cptoy\\.com"},
      {"name":"crabtree-evelyn.co.uk","region":"UK","regex":"^https?://(www\\.)?crabtree-evelyn\\.co\\.uk"},
      {"name":"crabtree-evelyn.com","region":"US","regex":"^https?://(www\\.)?crabtree-evelyn\\.com"},
      {"name":"crafterschoice.com","region":"US","regex":"^https?://(www\\.)?crafterschoice\\.com"},
      {"name":"crayolastore.com","region":"US","regex":"^https?://(www\\.)?crayolastore\\.com"},
      {"name":"crazy-presents.de","region":"US","regex":"^https?://(www\\.)?crazy-presents\\.de"},
      {"name":"crocs.co.uk","region":"UK","regex":"^https?://(www\\.)?crocs\\.co\\.uk"},
      {"name":"crocs.de","region":"DE","regex":"^https?://(www\\.)?crocs\\.de"},
      {"name":"crossings.com","region":"US","regex":"^https?://(www\\.)?crossings\\.com"},
      {"name":"crotchet.co.uk","region":"UK","regex":"^https?://(www\\.)?crotchet\\.co\\.uk"},
      {"name":"ctshirts.co.uk","region":"UK","regex":"^https?://(www\\.)?ctshirts\\.co\\.uk"},
      {"name":"cult.co.uk","region":"UK","regex":"^https?://(www\\.)?cult\\.co\\.uk"},
      {"name":"cultbeauty.co.uk","region":"UK","regex":"^https?://(www\\.)?cultbeauty\\.co\\.uk"},
      {"name":"currentcatalog.com","region":"US","regex":"^https?://(www\\.)?currentcatalog\\.com"},
      {"name":"currentlabels.com","region":"US","regex":"^https?://(www\\.)?currentlabels\\.com"},
      {"name":"cushe.com","region":"US","regex":"^https?://(www\\.)?cushe\\.com"},
      {"name":"cwimedical.com","region":"US","regex":"^https?://(www\\.)?cwimedical\\.com"},
      {"name":"cxlondon.com","region":"UK","regex":"^https?://(www\\.)?cxlondon\\.com"},
      {"name":"cyclegear.com","region":"US","regex":"^https?://(www\\.)?cyclegear\\.com"},
      {"name":"dailyobsessions.com","region":"DE","regex":"^https?://(www\\.)?dailyobsessions\\.com"},
      {"name":"dallmayr-versand.de","region":"DE","regex":"^https?://(www\\.)?dallmayr-versand\\.de"},
      {"name":"dancingdeer.com","region":"US","regex":"^https?://(www\\.)?dancingdeer\\.com"},
      {"name":"danieljouvance.com","region":"US","regex":"^https?://(www\\.)?danieljouvance\\.com"},
      {"name":"danskin.com","region":"US","regex":"^https?://(www\\.)?danskin\\.com"},
      {"name":"darlingsofchelsea.co.uk","region":"UK","regex":"^https?://(www\\.)?darlingsofchelsea\\.co\\.uk"},
      {"name":"dasphoto.de","region":"DE","regex":"^https?://(www\\.)?dasphoto\\.de"},
      {"name":"databecker.de","region":"DE","regex":"^https?://(www\\.)?databecker\\.de"},
      {"name":"davidscookies.com","region":"US","regex":"^https?://(www\\.)?davidscookies\\.com"},
      {"name":"daxon.co.uk","region":"UK","regex":"^https?://(www\\.)?daxon\\.co\\.uk"},
      {"name":"day2dayshop.com","region":"UK","regex":"^https?://(www\\.)?day2dayshop\\.com"},
      {"name":"ddrgame.com","region":"US","regex":"^https?://(www\\.)?ddrgame\\.com"},
      {"name":"dealsmamapedia.com","region":"US","regex":"^https?://(www\\.)?dealsmamapedia\\.com"},
      {"name":"debenhams.com","region":"UK","regex":"^https?://(www\\.)?debenhams\\.com"},
      {"name":"decalgirl.com","region":"US","regex":"^https?://(www\\.)?decalgirl\\.com"},
      {"name":"deerwinmueller.com","region":"US","regex":"^https?://(www\\.)?deerwinmueller\\.com"},
      {"name":"deforzieri.com","region":"US","regex":"^https?://(www\\.)?deforzieri\\.com"},
      {"name":"dehotels.com","region":"US","regex":"^https?://(www\\.)?dehotels\\.com"},
      {"name":"dein-ebook-shop.com","region":"DE","regex":"^https?://(www\\.)?dein-ebook-shop\\.com"},
      {"name":"dellamoda.com","region":"US","regex":"^https?://(www\\.)?dellamoda\\.com"},
      {"name":"delrossa.com","region":"US","regex":"^https?://(www\\.)?delrossa\\.com"},
      {"name":"denarasilk.com","region":"US","regex":"^https?://(www\\.)?denarasilk\\.com"},
      {"name":"dermstore.com","region":"US","regex":"^https?://(www\\.)?dermstore\\.com"},
      {"name":"designdot.de","region":"DE","regex":"^https?://(www\\.)?designdot\\.de"},
      {"name":"designer-bad.com","region":"US","regex":"^https?://(www\\.)?designer-bad\\.com"},
      {"name":"designerdiscount.co.uk","region":"UK","regex":"^https?://(www\\.)?designerdiscount\\.co\\.uk"},
      {"name":"designerliving.com","region":"US","regex":"^https?://(www\\.)?designerliving\\.com"},
      {"name":"designermode.com","region":"DE","regex":"^https?://(www\\.)?designermode\\.com"},
      {"name":"designersguild.com","region":"UK","regex":"^https?://(www\\.)?designersguild\\.com"},
      {"name":"designskins.com","region":"US","regex":"^https?://(www\\.)?designskins\\.com"},
      {"name":"desmazieres-shoes.co.uk","region":"UK","regex":"^https?://(www\\.)?desmazieres-shoes\\.co\\.uk"},
      {"name":"dessous-monde.de","region":"US","regex":"^https?://(www\\.)?dessous-monde\\.de"},
      {"name":"devilwear.co.uk","region":"UK","regex":"^https?://(www\\.)?devilwear\\.co\\.uk"},
      {"name":"dexer.de","region":"US","regex":"^https?://(www\\.)?dexer\\.de"},
      {"name":"dfdsseaways.com","region":"US","regex":"^https?://(www\\.)?dfdsseaways\\.com"},
      {"name":"dhr.com","region":"US","regex":"^https?://(www\\.)?dhr\\.com"},
      {"name":"dhstyles.com","region":"US","regex":"^https?://(www\\.)?dhstyles\\.com"},
      {"name":"diamondnexuslabs.com","region":"US","regex":"^https?://(www\\.)?diamondnexuslabs\\.com"},
      {"name":"diamondwave.com","region":"US","regex":"^https?://(www\\.)?diamondwave\\.com"},
      {"name":"didagoshop.de","region":"DE","regex":"^https?://(www\\.)?didagoshop\\.de"},
      {"name":"diddl-laedchen.de","region":"US","regex":"^https?://(www\\.)?diddl-laedchen\\.de"},
      {"name":"diecastmodelswholesale.com","region":"US","regex":"^https?://(www\\.)?diecastmodelswholesale\\.com"},
      {"name":"diedruckerei.de","region":"DE","regex":"^https?://(www\\.)?diedruckerei\\.de"},
      {"name":"digitalfotoversand.de","region":"DE","regex":"^https?://(www\\.)?digitalfotoversand\\.de"},
      {"name":"digitalrev.com","region":"US","regex":"^https?://(www\\.)?digitalrev\\.com"},
      {"name":"digitalriver.com","region":"US","regex":"^https?://(www\\.)?digitalriver\\.com"},
      {"name":"digon.de","region":"DE","regex":"^https?://(www\\.)?digon\\.de"},
      {"name":"dinette.com","region":"US","regex":"^https?://(www\\.)?dinette\\.com"},
      {"name":"dinodirect.com","region":"US","regex":"^https?://(www\\.)?dinodirect\\.com"},
      {"name":"directgardening.com","region":"US","regex":"^https?://(www\\.)?directgardening\\.com"},
      {"name":"directtvs.co.uk","region":"UK","regex":"^https?://(www\\.)?directtvs\\.co\\.uk"},
      {"name":"discount-supplements.co.uk","region":"UK","regex":"^https?://(www\\.)?discount-supplements\\.co\\.uk"},
      {"name":"discountramps.com","region":"US","regex":"^https?://(www\\.)?discountramps\\.com"},
      {"name":"discountschoolsupply.com","region":"US","regex":"^https?://(www\\.)?discountschoolsupply\\.com"},
      {"name":"discountshoestore.co.uk","region":"UK","regex":"^https?://(www\\.)?discountshoestore\\.co\\.uk"},
      {"name":"divers-supply.com","region":"US","regex":"^https?://(www\\.)?divers-supply\\.com"},
      {"name":"diytools.co.uk","region":"UK","regex":"^https?://(www\\.)?diytools\\.co\\.uk"},
      {"name":"djpremium.com","region":"US","regex":"^https?://(www\\.)?djpremium\\.com"},
      {"name":"dliwin.com","region":"US","regex":"^https?://(www\\.)?dliwin\\.com"},
      {"name":"dnafootwear.com","region":"US","regex":"^https?://(www\\.)?dnafootwear\\.com"},
      {"name":"doccheck.com","region":"DE","regex":"^https?://(www\\.)?doccheck\\.com"},
      {"name":"docmorris.de","region":"DE","regex":"^https?://(www\\.)?docmorris\\.de"},
      {"name":"dogeared.com","region":"US","regex":"^https?://(www\\.)?dogeared\\.com"},
      {"name":"doghousesaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?doghousesaffiliatetechnology\\.com"},
      {"name":"dokteronline.com","region":"DE","regex":"^https?://(www\\.)?dokteronline\\.com"},
      {"name":"dollardays.com","region":"US","regex":"^https?://(www\\.)?dollardays\\.com"},
      {"name":"dorothyperkins.com","region":"UK","regex":"^https?://(www\\.)?dorothyperkins\\.com"},
      {"name":"dosomethingdifferent.com","region":"UK","regex":"^https?://(www\\.)?dosomethingdifferent\\.com"},
      {"name":"doubledaybookclub.com","region":"US","regex":"^https?://(www\\.)?doubledaybookclub\\.com"},
      {"name":"doubledaylargeprint.com","region":"US","regex":"^https?://(www\\.)?doubledaylargeprint\\.com"},
      {"name":"douglascuddletoy.com","region":"US","regex":"^https?://(www\\.)?douglascuddletoy\\.com"},
      {"name":"dreams.co.uk","region":"UK","regex":"^https?://(www\\.)?dreams\\.co\\.uk"},
      {"name":"dress-for-less.com","region":"UK","regex":"^https?://(www\\.)?dress-for-less\\.com"},
      {"name":"drinkstuff.com","region":"UK","regex":"^https?://(www\\.)?drinkstuff\\.com"},
      {"name":"drjays.com","region":"US","regex":"^https?://(www\\.)?drjays\\.com"},
      {"name":"drleonards.com","region":"US","regex":"^https?://(www\\.)?drleonards\\.com"},
      {"name":"drschollsshoes.com","region":"US","regex":"^https?://(www\\.)?drschollsshoes\\.com"},
      {"name":"drwhitaker.com","region":"US","regex":"^https?://(www\\.)?drwhitaker\\.com"},
      {"name":"dsl1und1.de","region":"DE","regex":"^https?://(www\\.)?dsl1und1\\.de"},
      {"name":"dtydirect.com","region":"US","regex":"^https?://(www\\.)?dtydirect\\.com"},
      {"name":"duncraft.com","region":"US","regex":"^https?://(www\\.)?duncraft\\.com"},
      {"name":"duoboots.com","region":"UK","regex":"^https?://(www\\.)?duoboots\\.com"},
      {"name":"dutchgardens.com","region":"US","regex":"^https?://(www\\.)?dutchgardens\\.com"},
      {"name":"duw-shop.de","region":"DE","regex":"^https?://(www\\.)?duw-shop\\.de"},
      {"name":"e-bug.de","region":"DE","regex":"^https?://(www\\.)?e-bug\\.de"},
      {"name":"e-domizil.de","region":"DE","regex":"^https?://(www\\.)?e-domizil\\.de"},
      {"name":"e-flowersuk.co.uk","region":"UK","regex":"^https?://(www\\.)?e-flowersuk\\.co\\.uk"},
      {"name":"easyart.com","region":"UK","regex":"^https?://(www\\.)?easyart\\.com"},
      {"name":"ebrosia.de","region":"DE","regex":"^https?://(www\\.)?ebrosia\\.de"},
      {"name":"ecarpetgallery.com","region":"US","regex":"^https?://(www\\.)?ecarpetgallery\\.com"},
      {"name":"echemist.co.uk","region":"UK","regex":"^https?://(www\\.)?echemist\\.co\\.uk"},
      {"name":"eckball.de","region":"US","regex":"^https?://(www\\.)?eckball\\.de"},
      {"name":"ecolan.biz","region":"DE","regex":"^https?://(www\\.)?ecolan\\.biz"},
      {"name":"eddiebauer.com","region":"US","regex":"^https?://(www\\.)?eddiebauer\\.com"},
      {"name":"edeka24.de","region":"DE","regex":"^https?://(www\\.)?edeka24\\.de"},
      {"name":"edenfantasys.com","region":"US","regex":"^https?://(www\\.)?edenfantasys\\.com"},
      {"name":"edesignershop.net","region":"US","regex":"^https?://(www\\.)?edesignershop\\.net"},
      {"name":"eharlequin.com","region":"US","regex":"^https?://(www\\.)?eharlequin\\.com"},
      {"name":"einmalige-erlebnisse.de","region":"US","regex":"^https?://(www\\.)?einmalige-erlebnisse\\.de"},
      {"name":"elbenwald.de","region":"DE","regex":"^https?://(www\\.)?elbenwald\\.de"},
      {"name":"electricaldiscountuk.co.uk","region":"UK","regex":"^https?://(www\\.)?electricaldiscountuk\\.co\\.uk"},
      {"name":"electricalexperience.co.uk","region":"UK","regex":"^https?://(www\\.)?electricalexperience\\.co\\.uk"},
      {"name":"electricshopping.com","region":"UK","regex":"^https?://(www\\.)?electricshopping\\.com"},
      {"name":"elegance.de","region":"DE","regex":"^https?://(www\\.)?elegance\\.de"},
      {"name":"elkcreekvineyards.com","region":"US","regex":"^https?://(www\\.)?elkcreekvineyards\\.com"},
      {"name":"ella-home.de","region":"US","regex":"^https?://(www\\.)?ella-home\\.de"},
      {"name":"eload24.com","region":"US","regex":"^https?://(www\\.)?eload24\\.com"},
      {"name":"elv.de","region":"DE","regex":"^https?://(www\\.)?elv\\.de"},
      {"name":"emeamicrosoftstore.com","region":"US","regex":"^https?://(www\\.)?emeamicrosoftstore\\.com"},
      {"name":"empressia.de","region":"DE","regex":"^https?://(www\\.)?empressia\\.de"},
      {"name":"ems.com","region":"US","regex":"^https?://(www\\.)?ems\\.com"},
      {"name":"endlichzuhause.de","region":"DE","regex":"^https?://(www\\.)?endlichzuhause\\.de"},
      {"name":"equestriancollections.com","region":"US","regex":"^https?://(www\\.)?equestriancollections\\.com"},
      {"name":"ernestjones.co.uk","region":"UK","regex":"^https?://(www\\.)?ernestjones\\.co\\.uk"},
      {"name":"escalla.eu","region":"DE","regex":"^https?://(www\\.)?escalla\\.eu"},
      {"name":"espemporiumaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?espemporiumaffiliatetechnology\\.com"},
      {"name":"esportsonline.com","region":"US","regex":"^https?://(www\\.)?esportsonline\\.com"},
      {"name":"eteleon.de","region":"DE","regex":"^https?://(www\\.)?eteleon\\.de"},
      {"name":"eterna.de","region":"DE","regex":"^https?://(www\\.)?eterna\\.de"},
      {"name":"euforzieri.com","region":"US","regex":"^https?://(www\\.)?euforzieri\\.com"},
      {"name":"eurochrono.com","region":"US","regex":"^https?://(www\\.)?eurochrono\\.com"},
      {"name":"eurolens.co.uk","region":"UK","regex":"^https?://(www\\.)?eurolens\\.co\\.uk"},
      {"name":"eurolens.com","region":"DE","regex":"^https?://(www\\.)?eurolens\\.com"},
      {"name":"euronics.de","region":"DE","regex":"^https?://(www\\.)?euronics\\.de"},
      {"name":"eustrawberrynet.com","region":"DE","regex":"^https?://(www\\.)?eustrawberrynet\\.com"},
      {"name":"evanscycles.com","region":"UK","regex":"^https?://(www\\.)?evanscycles\\.com"},
      {"name":"evitamins.com","region":"US","regex":"^https?://(www\\.)?evitamins\\.com"},
      {"name":"evocal.co.uk","region":"UK","regex":"^https?://(www\\.)?evocal\\.co\\.uk"},
      {"name":"eworld24.de","region":"DE","regex":"^https?://(www\\.)?eworld24\\.de"},
      {"name":"exelement.co.uk","region":"UK","regex":"^https?://(www\\.)?exelement\\.co\\.uk"},
      {"name":"expedia.co.uk","region":"US","regex":"^https?://(www\\.)?expedia\\.co\\.uk"},
      {"name":"expedia.de","region":"DE","regex":"^https?://(www\\.)?expedia\\.de"},
      {"name":"expressionery.com","region":"US","regex":"^https?://(www\\.)?expressionery\\.com"},
      {"name":"eyebuydirect.com","region":"US","regex":"^https?://(www\\.)?eyebuydirect\\.com"},
      {"name":"eyesave.com","region":"US","regex":"^https?://(www\\.)?eyesave\\.com"},
      {"name":"eyeslipsface.com","region":"US","regex":"^https?://(www\\.)?eyeslipsface\\.com"},
      {"name":"fabric.com","region":"US","regex":"^https?://(www\\.)?fabric\\.com"},
      {"name":"fads.co.uk","region":"UK","regex":"^https?://(www\\.)?fads\\.co\\.uk"},
      {"name":"fandango.com","region":"US","regex":"^https?://(www\\.)?fandango\\.com"},
      {"name":"fanzz.com","region":"US","regex":"^https?://(www\\.)?fanzz\\.com"},
      {"name":"fashion4home.co.uk","region":"UK","regex":"^https?://(www\\.)?fashion4home\\.co\\.uk"},
      {"name":"fashioncode.de","region":"US","regex":"^https?://(www\\.)?fashioncode\\.de"},
      {"name":"fashionsisters.de","region":"DE","regex":"^https?://(www\\.)?fashionsisters\\.de"},
      {"name":"fashionspecialists.com","region":"US","regex":"^https?://(www\\.)?fashionspecialists\\.com"},
      {"name":"fashionworld.co.uk","region":"UK","regex":"^https?://(www\\.)?fashionworld\\.co\\.uk"},
      {"name":"fatboy.co.uk","region":"UK","regex":"^https?://(www\\.)?fatboy\\.co\\.uk"},
      {"name":"fatface.com","region":"UK","regex":"^https?://(www\\.)?fatface\\.com"},
      {"name":"favoraffair.com","region":"US","regex":"^https?://(www\\.)?favoraffair\\.com"},
      {"name":"feelgood-shop.com","region":"DE","regex":"^https?://(www\\.)?feelgood-shop\\.com"},
      {"name":"fergieshoes.com","region":"US","regex":"^https?://(www\\.)?fergieshoes\\.com"},
      {"name":"ferrari.com","region":"US","regex":"^https?://(www\\.)?ferrari\\.com"},
      {"name":"ferret.com","region":"US","regex":"^https?://(www\\.)?ferret\\.com"},
      {"name":"fhinds.co.uk","region":"UK","regex":"^https?://(www\\.)?fhinds\\.co\\.uk"},
      {"name":"filofax.co.uk","region":"UK","regex":"^https?://(www\\.)?filofax\\.co\\.uk"},
      {"name":"find-me-a-gift.co.uk","region":"UK","regex":"^https?://(www\\.)?find-me-a-gift\\.co\\.uk"},
      {"name":"findjewellery.co.uk","region":"UK","regex":"^https?://(www\\.)?findjewellery\\.co\\.uk"},
      {"name":"finejewelers.com","region":"US","regex":"^https?://(www\\.)?finejewelers\\.com"},
      {"name":"finetuxedos.com","region":"US","regex":"^https?://(www\\.)?finetuxedos\\.com"},
      {"name":"firebox.com","region":"UK","regex":"^https?://(www\\.)?firebox\\.com"},
      {"name":"fischfuttertreff.de","region":"US","regex":"^https?://(www\\.)?fischfuttertreff\\.de"},
      {"name":"fishtec.co.uk","region":"UK","regex":"^https?://(www\\.)?fishtec\\.co\\.uk"},
      {"name":"fit-z.de","region":"DE","regex":"^https?://(www\\.)?fit-z\\.de"},
      {"name":"fitness.de","region":"DE","regex":"^https?://(www\\.)?fitness\\.de"},
      {"name":"fitnessoptions.co.uk","region":"UK","regex":"^https?://(www\\.)?fitnessoptions\\.co\\.uk"},
      {"name":"fitstore24.com","region":"DE","regex":"^https?://(www\\.)?fitstore24\\.com"},
      {"name":"fleurop.de","region":"DE","regex":"^https?://(www\\.)?fleurop\\.de"},
      {"name":"flora2000.com","region":"US","regex":"^https?://(www\\.)?flora2000\\.com"},
      {"name":"floraflora.com","region":"US","regex":"^https?://(www\\.)?floraflora\\.com"},
      {"name":"floraprima.de","region":"DE","regex":"^https?://(www\\.)?floraprima\\.de"},
      {"name":"florsheim.com","region":"US","regex":"^https?://(www\\.)?florsheim\\.com"},
      {"name":"flowersacrossamerica.com","region":"US","regex":"^https?://(www\\.)?flowersacrossamerica\\.com"},
      {"name":"flowersfast.com","region":"US","regex":"^https?://(www\\.)?flowersfast\\.com"},
      {"name":"fluance.com","region":"US","regex":"^https?://(www\\.)?fluance\\.com"},
      {"name":"flyingflowers.co.uk","region":"UK","regex":"^https?://(www\\.)?flyingflowers\\.co\\.uk"},
      {"name":"fonts.com","region":"US","regex":"^https?://(www\\.)?fonts\\.com"},
      {"name":"foodbox.de","region":"DE","regex":"^https?://(www\\.)?foodbox\\.de"},
      {"name":"footasylum.com","region":"UK","regex":"^https?://(www\\.)?footasylum\\.com"},
      {"name":"footpetals.com","region":"US","regex":"^https?://(www\\.)?footpetals\\.com"},
      {"name":"footsteps.de","region":"DE","regex":"^https?://(www\\.)?footsteps\\.de"},
      {"name":"footwearetcaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?footwearetcaffiliatetechnology\\.com"},
      {"name":"fossil.co.uk","region":"UK","regex":"^https?://(www\\.)?fossil\\.co\\.uk"},
      {"name":"fotoalbumfotobuch.de","region":"US","regex":"^https?://(www\\.)?fotoalbumfotobuch\\.de"},
      {"name":"fotokasten.de","region":"DE","regex":"^https?://(www\\.)?fotokasten\\.de"},
      {"name":"fotopost24.de","region":"DE","regex":"^https?://(www\\.)?fotopost24\\.de"},
      {"name":"fotopuzzle.de","region":"DE","regex":"^https?://(www\\.)?fotopuzzle\\.de"},
      {"name":"foxshopseenon.com","region":"US","regex":"^https?://(www\\.)?foxshopseenon\\.com"},
      {"name":"fraas.com","region":"DE","regex":"^https?://(www\\.)?fraas\\.com"},
      {"name":"fragrancedirect.co.uk","region":"UK","regex":"^https?://(www\\.)?fragrancedirect\\.co\\.uk"},
      {"name":"framesdirect.co.uk","region":"US","regex":"^https?://(www\\.)?framesdirect\\.co\\.uk"},
      {"name":"framesdirect.com","region":"US","regex":"^https?://(www\\.)?framesdirect\\.com"},
      {"name":"frankbeecostume.com","region":"US","regex":"^https?://(www\\.)?frankbeecostume\\.com"},
      {"name":"frankdandy.com","region":"US","regex":"^https?://(www\\.)?frankdandy\\.com"},
      {"name":"franklinplanner.com","region":"US","regex":"^https?://(www\\.)?franklinplanner\\.com"},
      {"name":"freedomchair.com","region":"US","regex":"^https?://(www\\.)?freedomchair\\.com"},
      {"name":"freemans.com","region":"UK","regex":"^https?://(www\\.)?freemans\\.com"},
      {"name":"freestylextreme.com","region":"UK","regex":"^https?://(www\\.)?freestylextreme\\.com"},
      {"name":"friedrich-verlag.de","region":"US","regex":"^https?://(www\\.)?friedrich-verlag\\.de"},
      {"name":"fromyouflowers.com","region":"US","regex":"^https?://(www\\.)?fromyouflowers\\.com"},
      {"name":"ftpress.com","region":"US","regex":"^https?://(www\\.)?ftpress\\.com"},
      {"name":"fun4kids.co.uk","region":"UK","regex":"^https?://(www\\.)?fun4kids\\.co\\.uk"},
      {"name":"function18.com","region":"UK","regex":"^https?://(www\\.)?function18\\.com"},
      {"name":"furniture123.co.uk","region":"UK","regex":"^https?://(www\\.)?furniture123\\.co\\.uk"},
      {"name":"furniturevillage.co.uk","region":"UK","regex":"^https?://(www\\.)?furniturevillage\\.co\\.uk"},
      {"name":"gaastraproshop.com","region":"US","regex":"^https?://(www\\.)?gaastraproshop\\.com"},
      {"name":"gadgets.co.uk","region":"UK","regex":"^https?://(www\\.)?gadgets\\.co\\.uk"},
      {"name":"gadgettown.com","region":"US","regex":"^https?://(www\\.)?gadgettown\\.com"},
      {"name":"gagamoto.de","region":"DE","regex":"^https?://(www\\.)?gagamoto\\.de"},
      {"name":"gainsaver.com","region":"US","regex":"^https?://(www\\.)?gainsaver\\.com"},
      {"name":"gallerycollection.com","region":"US","regex":"^https?://(www\\.)?gallerycollection\\.com"},
      {"name":"galleryy.net","region":"US","regex":"^https?://(www\\.)?galleryy\\.net"},
      {"name":"gamefly.com","region":"US","regex":"^https?://(www\\.)?gamefly\\.com"},
      {"name":"gamersgate.com","region":"US","regex":"^https?://(www\\.)?gamersgate\\.com"},
      {"name":"gameshark.com","region":"US","regex":"^https?://(www\\.)?gameshark\\.com"},
      {"name":"gamesload.de","region":"DE","regex":"^https?://(www\\.)?gamesload\\.de"},
      {"name":"gamestop.com","region":"US","regex":"^https?://(www\\.)?gamestop\\.com"},
      {"name":"gamolagolf.co.uk","region":"UK","regex":"^https?://(www\\.)?gamolagolf\\.co\\.uk"},
      {"name":"gapadventures.com","region":"UK","regex":"^https?://(www\\.)?gapadventures\\.com"},
      {"name":"gapadventures.com","region":"US","regex":"^https?://(www\\.)?gapadventures\\.com"},
      {"name":"garden.co.uk","region":"UK","regex":"^https?://(www\\.)?garden\\.co\\.uk"},
      {"name":"gardenbird.co.uk","region":"UK","regex":"^https?://(www\\.)?gardenbird\\.co\\.uk"},
      {"name":"gardencentreonline.co.uk","region":"UK","regex":"^https?://(www\\.)?gardencentreonline\\.co\\.uk"},
      {"name":"garten-schlueter.de","region":"US","regex":"^https?://(www\\.)?garten-schlueter\\.de"},
      {"name":"gartenmoebel.de","region":"US","regex":"^https?://(www\\.)?gartenmoebel\\.de"},
      {"name":"gartentotal.de","region":"DE","regex":"^https?://(www\\.)?gartentotal\\.de"},
      {"name":"gear4music.com","region":"UK","regex":"^https?://(www\\.)?gear4music\\.com"},
      {"name":"gelaskins.com","region":"US","regex":"^https?://(www\\.)?gelaskins\\.com"},
      {"name":"gemondo.com","region":"UK","regex":"^https?://(www\\.)?gemondo\\.com"},
      {"name":"genesisautoparts.com","region":"US","regex":"^https?://(www\\.)?genesisautoparts\\.com"},
      {"name":"gentlemans-shop.com","region":"UK","regex":"^https?://(www\\.)?gentlemans-shop\\.com"},
      {"name":"german-dream-nails.com","region":"DE","regex":"^https?://(www\\.)?german-dream-nails\\.com"},
      {"name":"geschenkidee.de","region":"DE","regex":"^https?://(www\\.)?geschenkidee\\.de"},
      {"name":"getlenses.co.uk","region":"UK","regex":"^https?://(www\\.)?getlenses\\.co\\.uk"},
      {"name":"getreidemuehlenshop.de","region":"DE","regex":"^https?://(www\\.)?getreidemuehlenshop\\.de"},
      {"name":"getshoes.de","region":"US","regex":"^https?://(www\\.)?getshoes\\.de"},
      {"name":"getthelabel.com","region":"UK","regex":"^https?://(www\\.)?getthelabel\\.com"},
      {"name":"gettingpersonal.co.uk","region":"UK","regex":"^https?://(www\\.)?gettingpersonal\\.co\\.uk"},
      {"name":"giftsredenvelope.com","region":"US","regex":"^https?://(www\\.)?giftsredenvelope\\.com"},
      {"name":"giglio.com","region":"DE","regex":"^https?://(www\\.)?giglio\\.com"},
      {"name":"gizoo.co.uk","region":"UK","regex":"^https?://(www\\.)?gizoo\\.co\\.uk"},
      {"name":"gizzmoheaven.com","region":"UK","regex":"^https?://(www\\.)?gizzmoheaven\\.com"},
      {"name":"glassesshop.com","region":"US","regex":"^https?://(www\\.)?glassesshop\\.com"},
      {"name":"glassesusa.com","region":"US","regex":"^https?://(www\\.)?glassesusa\\.com"},
      {"name":"gltc.co.uk","region":"UK","regex":"^https?://(www\\.)?gltc\\.co\\.uk"},
      {"name":"glutencheck.com","region":"US","regex":"^https?://(www\\.)?glutencheck\\.com"},
      {"name":"go-electrical.co.uk","region":"UK","regex":"^https?://(www\\.)?go-electrical\\.co\\.uk"},
      {"name":"goaliemonkeyaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?goaliemonkeyaffiliatetechnology\\.com"},
      {"name":"godynamic-tracking.de","region":"DE","regex":"^https?://(www\\.)?godynamic-tracking\\.de"},
      {"name":"gojane.com","region":"US","regex":"^https?://(www\\.)?gojane\\.com"},
      {"name":"goldia.com","region":"US","regex":"^https?://(www\\.)?goldia\\.com"},
      {"name":"goldsmithsoutlet.co.uk","region":"UK","regex":"^https?://(www\\.)?goldsmithsoutlet\\.co\\.uk"},
      {"name":"golfdiscount.com","region":"US","regex":"^https?://(www\\.)?golfdiscount\\.com"},
      {"name":"golfgeardirect.co.uk","region":"UK","regex":"^https?://(www\\.)?golfgeardirect\\.co\\.uk"},
      {"name":"golfonline.co.uk","region":"UK","regex":"^https?://(www\\.)?golfonline\\.co\\.uk"},
      {"name":"golfsmith.com","region":"US","regex":"^https?://(www\\.)?golfsmith\\.com"},
      {"name":"goodwheel.de","region":"DE","regex":"^https?://(www\\.)?goodwheel\\.de"},
      {"name":"gourmetfleisch.de","region":"DE","regex":"^https?://(www\\.)?gourmetfleisch\\.de"},
      {"name":"gourmetgiftbaskets.com","region":"US","regex":"^https?://(www\\.)?gourmetgiftbaskets\\.com"},
      {"name":"gourvita.com","region":"US","regex":"^https?://(www\\.)?gourvita\\.com"},
      {"name":"govacuum.com","region":"US","regex":"^https?://(www\\.)?govacuum\\.com"},
      {"name":"gracedesigns.com","region":"US","regex":"^https?://(www\\.)?gracedesigns\\.com"},
      {"name":"grahamandgreen.co.uk","region":"UK","regex":"^https?://(www\\.)?grahamandgreen\\.co\\.uk"},
      {"name":"graveyardmall.com","region":"US","regex":"^https?://(www\\.)?graveyardmall\\.com"},
      {"name":"greatbigcanvas.com","region":"US","regex":"^https?://(www\\.)?greatbigcanvas\\.com"},
      {"name":"greatmagazines.co.uk","region":"UK","regex":"^https?://(www\\.)?greatmagazines\\.co\\.uk"},
      {"name":"greatskin.com","region":"US","regex":"^https?://(www\\.)?greatskin\\.com"},
      {"name":"greenality.de","region":"DE","regex":"^https?://(www\\.)?greenality\\.de"},
      {"name":"greenpeople.co.uk","region":"UK","regex":"^https?://(www\\.)?greenpeople\\.co\\.uk"},
      {"name":"groupon.co.uk","region":"UK","regex":"^https?://(www\\.)?groupon\\.co\\.uk"},
      {"name":"gruenspar.de","region":"DE","regex":"^https?://(www\\.)?gruenspar\\.de"},
      {"name":"guidogear.com","region":"US","regex":"^https?://(www\\.)?guidogear\\.com"},
      {"name":"guinnesswebstore.com","region":"US","regex":"^https?://(www\\.)?guinnesswebstore\\.com"},
      {"name":"gummylump.com","region":"US","regex":"^https?://(www\\.)?gummylump\\.com"},
      {"name":"guna.de","region":"DE","regex":"^https?://(www\\.)?guna\\.de"},
      {"name":"gustini.de","region":"DE","regex":"^https?://(www\\.)?gustini\\.de"},
      {"name":"habitat.co.uk","region":"UK","regex":"^https?://(www\\.)?habitat\\.co\\.uk"},
      {"name":"haburi.de","region":"DE","regex":"^https?://(www\\.)?haburi\\.de"},
      {"name":"hairproducts.com","region":"US","regex":"^https?://(www\\.)?hairproducts\\.com"},
      {"name":"halfpriceperfumes.co.uk","region":"UK","regex":"^https?://(www\\.)?halfpriceperfumes\\.co\\.uk"},
      {"name":"halloweenexpress.com","region":"US","regex":"^https?://(www\\.)?halloweenexpress\\.com"},
      {"name":"hammocksaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?hammocksaffiliatetechnology\\.com"},
      {"name":"handango.com","region":"US","regex":"^https?://(www\\.)?handango\\.com"},
      {"name":"handhelditems.com","region":"US","regex":"^https?://(www\\.)?handhelditems\\.com"},
      {"name":"handy.de","region":"DE","regex":"^https?://(www\\.)?handy\\.de"},
      {"name":"hanes-tshirts.eu","region":"DE","regex":"^https?://(www\\.)?hanes-tshirts\\.eu"},
      {"name":"hanfhaus.de","region":"US","regex":"^https?://(www\\.)?hanfhaus\\.de"},
      {"name":"happy-size.de","region":"DE","regex":"^https?://(www\\.)?happy-size\\.de"},
      {"name":"happyfans.de","region":"US","regex":"^https?://(www\\.)?happyfans\\.de"},
      {"name":"happysocks.com","region":"US","regex":"^https?://(www\\.)?happysocks\\.com"},
      {"name":"happysocks.com","region":"US","regex":"^https?://(www\\.)?happysocks\\.com"},
      {"name":"harryanddavid.com","region":"US","regex":"^https?://(www\\.)?harryanddavid\\.com"},
      {"name":"hawesko.de","region":"DE","regex":"^https?://(www\\.)?hawesko\\.de"},
      {"name":"haysominteriors.co.uk","region":"UK","regex":"^https?://(www\\.)?haysominteriors\\.co\\.uk"},
      {"name":"hbouk.com","region":"US","regex":"^https?://(www\\.)?hbouk\\.com"},
      {"name":"hearthsong.com","region":"US","regex":"^https?://(www\\.)?hearthsong\\.com"},
      {"name":"heideman-store.de","region":"DE","regex":"^https?://(www\\.)?heideman-store\\.de"},
      {"name":"hemdenbox.de","region":"DE","regex":"^https?://(www\\.)?hemdenbox\\.de"},
      {"name":"henkterhorst.de","region":"DE","regex":"^https?://(www\\.)?henkterhorst\\.de"},
      {"name":"henleys.co.uk","region":"UK","regex":"^https?://(www\\.)?henleys\\.co\\.uk"},
      {"name":"herbafit.de","region":"US","regex":"^https?://(www\\.)?herbafit\\.de"},
      {"name":"herrenausstatter.de","region":"DE","regex":"^https?://(www\\.)?herrenausstatter\\.de"},
      {"name":"hersheysstore.com","region":"US","regex":"^https?://(www\\.)?hersheysstore\\.com"},
      {"name":"hifishop24.de","region":"DE","regex":"^https?://(www\\.)?hifishop24\\.de"},
      {"name":"hiphopbling.com","region":"US","regex":"^https?://(www\\.)?hiphopbling\\.com"},
      {"name":"hiregirlmeetsdress.com","region":"UK","regex":"^https?://(www\\.)?hiregirlmeetsdress\\.com"},
      {"name":"hirekogolf.com","region":"US","regex":"^https?://(www\\.)?hirekogolf\\.com"},
      {"name":"historia.net","region":"DE","regex":"^https?://(www\\.)?historia\\.net"},
      {"name":"historybookclub.com","region":"US","regex":"^https?://(www\\.)?historybookclub\\.com"},
      {"name":"hobby-freizeit.de","region":"DE","regex":"^https?://(www\\.)?hobby-freizeit\\.de"},
      {"name":"hobbypartz.com","region":"US","regex":"^https?://(www\\.)?hobbypartz\\.com"},
      {"name":"hobbytron.com","region":"US","regex":"^https?://(www\\.)?hobbytron\\.com"},
      {"name":"hockeymonkeyaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?hockeymonkeyaffiliatetechnology\\.com"},
      {"name":"holidaylettings.co.uk","region":"UK","regex":"^https?://(www\\.)?holidaylettings\\.co\\.uk"},
      {"name":"holidaytaxis.com","region":"UK","regex":"^https?://(www\\.)?holidaytaxis\\.com"},
      {"name":"holz-haus.de","region":"DE","regex":"^https?://(www\\.)?holz-haus\\.de"},
      {"name":"homeandgardengifts.co.uk","region":"UK","regex":"^https?://(www\\.)?homeandgardengifts\\.co\\.uk"},
      {"name":"homebase.co.uk","region":"UK","regex":"^https?://(www\\.)?homebase\\.co\\.uk"},
      {"name":"homeeverything.com","region":"US","regex":"^https?://(www\\.)?homeeverything\\.com"},
      {"name":"homeofficesolutions.com","region":"US","regex":"^https?://(www\\.)?homeofficesolutions\\.com"},
      {"name":"homerunmonkeyaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?homerunmonkeyaffiliatetechnology\\.com"},
      {"name":"homestorecisco.com","region":"US","regex":"^https?://(www\\.)?homestorecisco\\.com"},
      {"name":"homestylebooks.com","region":"US","regex":"^https?://(www\\.)?homestylebooks\\.com"},
      {"name":"honeybell.com","region":"US","regex":"^https?://(www\\.)?honeybell\\.com"},
      {"name":"horoskope-direkt.de","region":"US","regex":"^https?://(www\\.)?horoskope-direkt\\.de"},
      {"name":"horrorklinik.de","region":"US","regex":"^https?://(www\\.)?horrorklinik\\.de"},
      {"name":"horseloverz.com","region":"US","regex":"^https?://(www\\.)?horseloverz\\.com"},
      {"name":"hostelbookers.com","region":"US","regex":"^https?://(www\\.)?hostelbookers\\.com"},
      {"name":"hotdiamonds.co.uk","region":"UK","regex":"^https?://(www\\.)?hotdiamonds\\.co\\.uk"},
      {"name":"hotelclub.com","region":"US","regex":"^https?://(www\\.)?hotelclub\\.com"},
      {"name":"hotelpronto.com","region":"UK","regex":"^https?://(www\\.)?hotelpronto\\.com"},
      {"name":"hotelweg.de","region":"DE","regex":"^https?://(www\\.)?hotelweg\\.de"},
      {"name":"hottershoes.com","region":"UK","regex":"^https?://(www\\.)?hottershoes\\.com"},
      {"name":"hottopic.com","region":"US","regex":"^https?://(www\\.)?hottopic\\.com"},
      {"name":"houseoffraser.co.uk","region":"UK","regex":"^https?://(www\\.)?houseoffraser\\.co\\.uk"},
      {"name":"housershoes.com","region":"US","regex":"^https?://(www\\.)?housershoes\\.com"},
      {"name":"housewaresdeals.com","region":"US","regex":"^https?://(www\\.)?housewaresdeals\\.com"},
      {"name":"hsamuel.co.uk","region":"UK","regex":"^https?://(www\\.)?hsamuel\\.co\\.uk"},
      {"name":"hse24.de","region":"DE","regex":"^https?://(www\\.)?hse24\\.de"},
      {"name":"hsssurf.com","region":"US","regex":"^https?://(www\\.)?hsssurf\\.com"},
      {"name":"hunkemoller.de","region":"DE","regex":"^https?://(www\\.)?hunkemoller\\.de"},
      {"name":"hurra.de","region":"DE","regex":"^https?://(www\\.)?hurra\\.de"},
      {"name":"hushpuppies.com","region":"US","regex":"^https?://(www\\.)?hushpuppies\\.com"},
      {"name":"hut.de","region":"US","regex":"^https?://(www\\.)?hut\\.de"},
      {"name":"hutshopping.de","region":"US","regex":"^https?://(www\\.)?hutshopping\\.de"},
      {"name":"hutx.de","region":"DE","regex":"^https?://(www\\.)?hutx\\.de"},
      {"name":"icejerseys.com","region":"US","regex":"^https?://(www\\.)?icejerseys\\.com"},
      {"name":"icons.com","region":"UK","regex":"^https?://(www\\.)?icons\\.com"},
      {"name":"ieschuh.co.uk","region":"DE","regex":"^https?://(www\\.)?ieschuh\\.co\\.uk"},
      {"name":"iflorist.co.uk","region":"UK","regex":"^https?://(www\\.)?iflorist\\.co\\.uk"},
      {"name":"igigi.com","region":"US","regex":"^https?://(www\\.)?igigi\\.com"},
      {"name":"igloo-store.com","region":"US","regex":"^https?://(www\\.)?igloo-store\\.com"},
      {"name":"imaginarium.de","region":"DE","regex":"^https?://(www\\.)?imaginarium\\.de"},
      {"name":"infinityshoes.com","region":"US","regex":"^https?://(www\\.)?infinityshoes\\.com"},
      {"name":"informit.com","region":"US","regex":"^https?://(www\\.)?informit\\.com"},
      {"name":"ingadi.de","region":"DE","regex":"^https?://(www\\.)?ingadi\\.de"},
      {"name":"ingramswaterandair.com","region":"US","regex":"^https?://(www\\.)?ingramswaterandair\\.com"},
      {"name":"inksmile.com","region":"US","regex":"^https?://(www\\.)?inksmile\\.com"},
      {"name":"inkxpressdirect.com","region":"UK","regex":"^https?://(www\\.)?inkxpressdirect\\.com"},
      {"name":"intelspy.com","region":"US","regex":"^https?://(www\\.)?intelspy\\.com"},
      {"name":"interrose.co.uk","region":"UK","regex":"^https?://(www\\.)?interrose\\.co\\.uk"},
      {"name":"intheswim.com","region":"US","regex":"^https?://(www\\.)?intheswim\\.com"},
      {"name":"intotheblue.co.uk","region":"UK","regex":"^https?://(www\\.)?intotheblue\\.co\\.uk"},
      {"name":"intrepidtravel.com","region":"UK","regex":"^https?://(www\\.)?intrepidtravel\\.com"},
      {"name":"invitationconsultants.com","region":"US","regex":"^https?://(www\\.)?invitationconsultants\\.com"},
      {"name":"inzinio.com","region":"US","regex":"^https?://(www\\.)?inzinio\\.com"},
      {"name":"iolo.com","region":"US","regex":"^https?://(www\\.)?iolo\\.com"},
      {"name":"ipanemaflipflops.co.uk","region":"UK","regex":"^https?://(www\\.)?ipanemaflipflops\\.co\\.uk"},
      {"name":"ipill.de","region":"US","regex":"^https?://(www\\.)?ipill\\.de"},
      {"name":"irobot.com","region":"US","regex":"^https?://(www\\.)?irobot\\.com"},
      {"name":"islandsurf.com","region":"US","regex":"^https?://(www\\.)?islandsurf\\.com"},
      {"name":"isubscribe.co.uk","region":"UK","regex":"^https?://(www\\.)?isubscribe\\.co\\.uk"},
      {"name":"itcfonts.com","region":"US","regex":"^https?://(www\\.)?itcfonts\\.com"},
      {"name":"itunesapple.com","region":"US","regex":"^https?://(www\\.)?itunesapple\\.com"},
      {"name":"jacamo.co.uk","region":"UK","regex":"^https?://(www\\.)?jacamo\\.co\\.uk"},
      {"name":"jacques-vert.co.uk","region":"UK","regex":"^https?://(www\\.)?jacques-vert\\.co\\.uk"},
      {"name":"jakewilson.com","region":"US","regex":"^https?://(www\\.)?jakewilson\\.com"},
      {"name":"jbpet.com","region":"US","regex":"^https?://(www\\.)?jbpet\\.com"},
      {"name":"jcwhitney.com","region":"US","regex":"^https?://(www\\.)?jcwhitney\\.com"},
      {"name":"jdsports.co.uk","region":"UK","regex":"^https?://(www\\.)?jdsports\\.co\\.uk"},
      {"name":"jdwilliams.co.uk","region":"UK","regex":"^https?://(www\\.)?jdwilliams\\.co\\.uk"},
      {"name":"jeanswelt.de","region":"DE","regex":"^https?://(www\\.)?jeanswelt\\.de"},
      {"name":"jellybelly.com","region":"US","regex":"^https?://(www\\.)?jellybelly\\.com"},
      {"name":"jerseyplantsdirect.com","region":"UK","regex":"^https?://(www\\.)?jerseyplantsdirect\\.com"},
      {"name":"jessicasimpsoncollection.com","region":"US","regex":"^https?://(www\\.)?jessicasimpsoncollection\\.com"},
      {"name":"jewelclub.com","region":"US","regex":"^https?://(www\\.)?jewelclub\\.com"},
      {"name":"jewelelegance.com","region":"US","regex":"^https?://(www\\.)?jewelelegance\\.com"},
      {"name":"jigsaw-online.com","region":"UK","regex":"^https?://(www\\.)?jigsaw-online\\.com"},
      {"name":"jigsawhealth.com","region":"US","regex":"^https?://(www\\.)?jigsawhealth\\.com"},
      {"name":"jjbsports.com","region":"UK","regex":"^https?://(www\\.)?jjbsports\\.com"},
      {"name":"jjgames.com","region":"US","regex":"^https?://(www\\.)?jjgames\\.com"},
      {"name":"jmldirect.com","region":"UK","regex":"^https?://(www\\.)?jmldirect\\.com"},
      {"name":"jobyaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?jobyaffiliatetechnology\\.com"},
      {"name":"joke.co.uk","region":"UK","regex":"^https?://(www\\.)?joke\\.co\\.uk"},
      {"name":"jollydays.de","region":"DE","regex":"^https?://(www\\.)?jollydays\\.de"},
      {"name":"jonesbootmaker.com","region":"UK","regex":"^https?://(www\\.)?jonesbootmaker\\.com"},
      {"name":"joska.com","region":"DE","regex":"^https?://(www\\.)?joska\\.com"},
      {"name":"jowa-bags.de","region":"US","regex":"^https?://(www\\.)?jowa-bags\\.de"},
      {"name":"jpeterman.com","region":"US","regex":"^https?://(www\\.)?jpeterman\\.com"},
      {"name":"juaraskincare.com","region":"US","regex":"^https?://(www\\.)?juaraskincare\\.com"},
      {"name":"junonia.com","region":"US","regex":"^https?://(www\\.)?junonia\\.com"},
      {"name":"justlenses.com","region":"US","regex":"^https?://(www\\.)?justlenses\\.com"},
      {"name":"justlife24.com","region":"US","regex":"^https?://(www\\.)?justlife24\\.com"},
      {"name":"justmysize.com","region":"US","regex":"^https?://(www\\.)?justmysize\\.com"},
      {"name":"kabeleins-fanshop.de","region":"DE","regex":"^https?://(www\\.)?kabeleins-fanshop\\.de"},
      {"name":"kabloom.com","region":"US","regex":"^https?://(www\\.)?kabloom\\.com"},
      {"name":"kahla-porzellanshop.de","region":"DE","regex":"^https?://(www\\.)?kahla-porzellanshop\\.de"},
      {"name":"kaleidoscope.co.uk","region":"UK","regex":"^https?://(www\\.)?kaleidoscope\\.co\\.uk"},
      {"name":"kalyx.com","region":"US","regex":"^https?://(www\\.)?kalyx\\.com"},
      {"name":"kansascitysteaks.com","region":"US","regex":"^https?://(www\\.)?kansascitysteaks\\.com"},
      {"name":"kapatcha.com","region":"DE","regex":"^https?://(www\\.)?kapatcha\\.com"},
      {"name":"karneval-megastore.de","region":"DE","regex":"^https?://(www\\.)?karneval-megastore\\.de"},
      {"name":"kaspersky.com","region":"US","regex":"^https?://(www\\.)?kaspersky\\.com"},
      {"name":"keeperskit.com","region":"UK","regex":"^https?://(www\\.)?keeperskit\\.com"},
      {"name":"kegworks.com","region":"US","regex":"^https?://(www\\.)?kegworks\\.com"},
      {"name":"keller-sports.de","region":"DE","regex":"^https?://(www\\.)?keller-sports\\.de"},
      {"name":"kidorable.com","region":"US","regex":"^https?://(www\\.)?kidorable\\.com"},
      {"name":"killerdana.com","region":"US","regex":"^https?://(www\\.)?killerdana\\.com"},
      {"name":"kirstein.de","region":"DE","regex":"^https?://(www\\.)?kirstein\\.de"},
      {"name":"kissafrog.de","region":"DE","regex":"^https?://(www\\.)?kissafrog\\.de"},
      {"name":"kitbag.com","region":"UK","regex":"^https?://(www\\.)?kitbag\\.com"},
      {"name":"kitchenfunesellerprostorefront.co.uk","region":"UK","regex":"^https?://(www\\.)?kitchenfunesellerprostorefront\\.co\\.uk"},
      {"name":"klebefieber.de","region":"DE","regex":"^https?://(www\\.)?klebefieber\\.de"},
      {"name":"klingel.de","region":"DE","regex":"^https?://(www\\.)?klingel\\.de"},
      {"name":"klm.com","region":"DE","regex":"^https?://(www\\.)?klm\\.com"},
      {"name":"kochland.de","region":"US","regex":"^https?://(www\\.)?kochland\\.de"},
      {"name":"kraeuterhaus.de","region":"US","regex":"^https?://(www\\.)?kraeuterhaus\\.de"},
      {"name":"kreativ-offensive.de","region":"US","regex":"^https?://(www\\.)?kreativ-offensive\\.de"},
      {"name":"krupsonlinestore.com","region":"US","regex":"^https?://(www\\.)?krupsonlinestore\\.com"},
      {"name":"kuechenhaus-online.com","region":"DE","regex":"^https?://(www\\.)?kuechenhaus-online\\.com"},
      {"name":"l-f-l.com","region":"US","regex":"^https?://(www\\.)?l-f-l\\.com"},
      {"name":"labelini.de","region":"US","regex":"^https?://(www\\.)?labelini\\.de"},
      {"name":"lacrosseaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?lacrosseaffiliatetechnology\\.com"},
      {"name":"lacrossemonkeyaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?lacrossemonkeyaffiliatetechnology\\.com"},
      {"name":"lampenwelt.de","region":"DE","regex":"^https?://(www\\.)?lampenwelt\\.de"},
      {"name":"landofnod.com","region":"US","regex":"^https?://(www\\.)?landofnod\\.com"},
      {"name":"landsend.co.uk","region":"US","regex":"^https?://(www\\.)?landsend\\.co\\.uk"},
      {"name":"lanebryant.com","region":"US","regex":"^https?://(www\\.)?lanebryant\\.com"},
      {"name":"laredoute.co.uk","region":"UK","regex":"^https?://(www\\.)?laredoute\\.co\\.uk"},
      {"name":"lastminute5vorflug.de","region":"DE","regex":"^https?://(www\\.)?lastminute5vorflug\\.de"},
      {"name":"lauraashley.com","region":"UK","regex":"^https?://(www\\.)?lauraashley\\.com"},
      {"name":"leiser.de","region":"DE","regex":"^https?://(www\\.)?leiser\\.de"},
      {"name":"lembrassa.com","region":"UK","regex":"^https?://(www\\.)?lembrassa\\.com"},
      {"name":"lengow.com","region":"DE","regex":"^https?://(www\\.)?lengow\\.com"},
      {"name":"lenilu.de","region":"DE","regex":"^https?://(www\\.)?lenilu\\.de"},
      {"name":"lens.com","region":"US","regex":"^https?://(www\\.)?lens\\.com"},
      {"name":"lensbay.com","region":"DE","regex":"^https?://(www\\.)?lensbay\\.com"},
      {"name":"lensbest.de","region":"DE","regex":"^https?://(www\\.)?lensbest\\.de"},
      {"name":"lenscatalogue.co.uk","region":"US","regex":"^https?://(www\\.)?lenscatalogue\\.co\\.uk"},
      {"name":"lensdealer.com","region":"DE","regex":"^https?://(www\\.)?lensdealer\\.com"},
      {"name":"lensprofi.de","region":"DE","regex":"^https?://(www\\.)?lensprofi\\.de"},
      {"name":"lensspirit.de","region":"DE","regex":"^https?://(www\\.)?lensspirit\\.de"},
      {"name":"lensway.co.uk","region":"US","regex":"^https?://(www\\.)?lensway\\.co\\.uk"},
      {"name":"lensway.de","region":"DE","regex":"^https?://(www\\.)?lensway\\.de"},
      {"name":"leonisa.com","region":"US","regex":"^https?://(www\\.)?leonisa\\.com"},
      {"name":"leuchtenstars.de","region":"DE","regex":"^https?://(www\\.)?leuchtenstars\\.de"},
      {"name":"lextuners.com","region":"US","regex":"^https?://(www\\.)?lextuners\\.com"},
      {"name":"lidl.de","region":"DE","regex":"^https?://(www\\.)?lidl\\.de"},
      {"name":"lids.ca","region":"US","regex":"^https?://(www\\.)?lids\\.ca"},
      {"name":"lids.com","region":"US","regex":"^https?://(www\\.)?lids\\.com"},
      {"name":"lifestride.com","region":"US","regex":"^https?://(www\\.)?lifestride\\.com"},
      {"name":"lighterside.com","region":"US","regex":"^https?://(www\\.)?lighterside\\.com"},
      {"name":"lightinthebox.com","region":"US","regex":"^https?://(www\\.)?lightinthebox\\.com"},
      {"name":"lights4fun.co.uk","region":"UK","regex":"^https?://(www\\.)?lights4fun\\.co\\.uk"},
      {"name":"lightsonlineaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?lightsonlineaffiliatetechnology\\.com"},
      {"name":"likoerfactory.de","region":"US","regex":"^https?://(www\\.)?likoerfactory\\.de"},
      {"name":"linensbargains.com","region":"US","regex":"^https?://(www\\.)?linensbargains\\.com"},
      {"name":"lingerie.com","region":"US","regex":"^https?://(www\\.)?lingerie\\.com"},
      {"name":"linksoflondon.com","region":"US","regex":"^https?://(www\\.)?linksoflondon\\.com"},
      {"name":"linotype.com","region":"US","regex":"^https?://(www\\.)?linotype\\.com"},
      {"name":"linsenpate.de","region":"DE","regex":"^https?://(www\\.)?linsenpate\\.de"},
      {"name":"listen2online.co.uk","region":"UK","regex":"^https?://(www\\.)?listen2online\\.co\\.uk"},
      {"name":"literaryguild.com","region":"US","regex":"^https?://(www\\.)?literaryguild\\.com"},
      {"name":"livingtools.de","region":"DE","regex":"^https?://(www\\.)?livingtools\\.de"},
      {"name":"livingxl.com","region":"US","regex":"^https?://(www\\.)?livingxl\\.com"},
      {"name":"logitech.com","region":"US","regex":"^https?://(www\\.)?logitech\\.com"},
      {"name":"logotolltags.com","region":"US","regex":"^https?://(www\\.)?logotolltags\\.com"},
      {"name":"lombok.co.uk","region":"UK","regex":"^https?://(www\\.)?lombok\\.co\\.uk"},
      {"name":"lookfantastic.com","region":"UK","regex":"^https?://(www\\.)?lookfantastic\\.com"},
      {"name":"lookmantastic.com","region":"UK","regex":"^https?://(www\\.)?lookmantastic\\.com"},
      {"name":"loserkids.com","region":"US","regex":"^https?://(www\\.)?loserkids\\.com"},
      {"name":"loudclothing.com","region":"UK","regex":"^https?://(www\\.)?loudclothing\\.com"},
      {"name":"loungedreams.com","region":"US","regex":"^https?://(www\\.)?loungedreams\\.com"},
      {"name":"love-scent.com","region":"US","regex":"^https?://(www\\.)?love-scent\\.com"},
      {"name":"lovell-rugby.co.uk","region":"UK","regex":"^https?://(www\\.)?lovell-rugby\\.co\\.uk"},
      {"name":"lovellsoccer.co.uk","region":"UK","regex":"^https?://(www\\.)?lovellsoccer\\.co\\.uk"},
      {"name":"lowcostholidays.com","region":"UK","regex":"^https?://(www\\.)?lowcostholidays\\.com"},
      {"name":"lucky-bike.de","region":"US","regex":"^https?://(www\\.)?lucky-bike\\.de"},
      {"name":"luggagebase.com","region":"US","regex":"^https?://(www\\.)?luggagebase\\.com"},
      {"name":"lugz.com","region":"US","regex":"^https?://(www\\.)?lugz\\.com"},
      {"name":"lumens.com","region":"US","regex":"^https?://(www\\.)?lumens\\.com"},
      {"name":"lunett-shop.de","region":"DE","regex":"^https?://(www\\.)?lunett-shop\\.de"},
      {"name":"luxxos.com","region":"DE","regex":"^https?://(www\\.)?luxxos\\.com"},
      {"name":"mackenzieltd.com","region":"US","regex":"^https?://(www\\.)?mackenzieltd\\.com"},
      {"name":"maedl.de","region":"DE","regex":"^https?://(www\\.)?maedl\\.de"},
      {"name":"magasino.com","region":"DE","regex":"^https?://(www\\.)?magasino\\.com"},
      {"name":"magellans.com","region":"US","regex":"^https?://(www\\.)?magellans\\.com"},
      {"name":"magiccabin.com","region":"US","regex":"^https?://(www\\.)?magiccabin\\.com"},
      {"name":"magix.com","region":"DE","regex":"^https?://(www\\.)?magix\\.com"},
      {"name":"majestic.co.uk","region":"UK","regex":"^https?://(www\\.)?majestic\\.co\\.uk"},
      {"name":"makari.com","region":"US","regex":"^https?://(www\\.)?makari\\.com"},
      {"name":"manhattanfruitier.com","region":"US","regex":"^https?://(www\\.)?manhattanfruitier\\.com"},
      {"name":"mantis.com","region":"US","regex":"^https?://(www\\.)?mantis\\.com"},
      {"name":"maplin.co.uk","region":"UK","regex":"^https?://(www\\.)?maplin\\.co\\.uk"},
      {"name":"maps.com","region":"US","regex":"^https?://(www\\.)?maps\\.com"},
      {"name":"marksandspencer.com","region":"UK","regex":"^https?://(www\\.)?marksandspencer\\.com"},
      {"name":"marriott.co.uk","region":"US","regex":"^https?://(www\\.)?marriott\\.co\\.uk"},
      {"name":"mastergardening.com","region":"US","regex":"^https?://(www\\.)?mastergardening\\.com"},
      {"name":"mattressonline.co.uk","region":"UK","regex":"^https?://(www\\.)?mattressonline\\.co\\.uk"},
      {"name":"maxcleavage.com","region":"UK","regex":"^https?://(www\\.)?maxcleavage\\.com"},
      {"name":"maxdome.de","region":"DE","regex":"^https?://(www\\.)?maxdome\\.de"},
      {"name":"maxicook.de","region":"DE","regex":"^https?://(www\\.)?maxicook\\.de"},
      {"name":"maxis-babywelt.de","region":"US","regex":"^https?://(www\\.)?maxis-babywelt\\.de"},
      {"name":"mediastorehouse.com","region":"UK","regex":"^https?://(www\\.)?mediastorehouse\\.com"},
      {"name":"medicom.de","region":"DE","regex":"^https?://(www\\.)?medicom\\.de"},
      {"name":"medion.com","region":"US","regex":"^https?://(www\\.)?medion\\.com"},
      {"name":"medpets.de","region":"DE","regex":"^https?://(www\\.)?medpets\\.de"},
      {"name":"mega-merchandise.de","region":"US","regex":"^https?://(www\\.)?mega-merchandise\\.de"},
      {"name":"megagadgets.de","region":"DE","regex":"^https?://(www\\.)?megagadgets\\.de"},
      {"name":"meghanshop.com","region":"US","regex":"^https?://(www\\.)?meghanshop\\.com"},
      {"name":"meguiarsdirect.com","region":"US","regex":"^https?://(www\\.)?meguiarsdirect\\.com"},
      {"name":"meinebabyflasche.de","region":"US","regex":"^https?://(www\\.)?meinebabyflasche\\.de"},
      {"name":"meinelinse.de","region":"DE","regex":"^https?://(www\\.)?meinelinse\\.de"},
      {"name":"melissaanddoug.com","region":"US","regex":"^https?://(www\\.)?melissaanddoug\\.com"},
      {"name":"melrosejewelers.com","region":"US","regex":"^https?://(www\\.)?melrosejewelers\\.com"},
      {"name":"memoryfoamwarehouse.co.uk","region":"UK","regex":"^https?://(www\\.)?memoryfoamwarehouse\\.co\\.uk"},
      {"name":"menkind.co.uk","region":"UK","regex":"^https?://(www\\.)?menkind\\.co\\.uk"},
      {"name":"mentaltraining-beckers.com","region":"DE","regex":"^https?://(www\\.)?mentaltraining-beckers\\.com"},
      {"name":"merrell.com","region":"US","regex":"^https?://(www\\.)?merrell\\.com"},
      {"name":"mexx.de","region":"DE","regex":"^https?://(www\\.)?mexx\\.de"},
      {"name":"mhbigbookofexercises.com","region":"US","regex":"^https?://(www\\.)?mhbigbookofexercises\\.com"},
      {"name":"michaelstarsaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?michaelstarsaffiliatetechnology\\.com"},
      {"name":"microdwarf.de","region":"US","regex":"^https?://(www\\.)?microdwarf\\.de"},
      {"name":"microsoftstore.com","region":"US","regex":"^https?://(www\\.)?microsoftstore\\.com"},
      {"name":"mightyleafaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?mightyleafaffiliatetechnology\\.com"},
      {"name":"mikasa.com","region":"US","regex":"^https?://(www\\.)?mikasa\\.com"},
      {"name":"milanoo.com","region":"US","regex":"^https?://(www\\.)?milanoo\\.com"},
      {"name":"militarybookclub.com","region":"US","regex":"^https?://(www\\.)?militarybookclub\\.com"},
      {"name":"millets.co.uk","region":"UK","regex":"^https?://(www\\.)?millets\\.co\\.uk"},
      {"name":"mindware.com","region":"US","regex":"^https?://(www\\.)?mindware\\.com"},
      {"name":"miniinthebox.com","region":"US","regex":"^https?://(www\\.)?miniinthebox\\.com"},
      {"name":"ministryofsound.com","region":"UK","regex":"^https?://(www\\.)?ministryofsound\\.com"},
      {"name":"missguided.co.uk","region":"UK","regex":"^https?://(www\\.)?missguided\\.co\\.uk"},
      {"name":"missselfridge.com","region":"UK","regex":"^https?://(www\\.)?missselfridge\\.com"},
      {"name":"misterspex.de","region":"DE","regex":"^https?://(www\\.)?misterspex\\.de"},
      {"name":"mjtrimaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?mjtrimaffiliatetechnology\\.com"},
      {"name":"mmoga.de","region":"DE","regex":"^https?://(www\\.)?mmoga\\.de"},
      {"name":"modclothaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?modclothaffiliatetechnology\\.com"},
      {"name":"modehaus-henssler.de","region":"US","regex":"^https?://(www\\.)?modehaus-henssler\\.de"},
      {"name":"modern-store.de","region":"DE","regex":"^https?://(www\\.)?modern-store\\.de"},
      {"name":"modernfurniture.com","region":"US","regex":"^https?://(www\\.)?modernfurniture\\.com"},
      {"name":"modernherbals.com","region":"UK","regex":"^https?://(www\\.)?modernherbals\\.com"},
      {"name":"modernnursery.com","region":"US","regex":"^https?://(www\\.)?modernnursery\\.com"},
      {"name":"modestern.de","region":"US","regex":"^https?://(www\\.)?modestern\\.de"},
      {"name":"moevenpick-wein.de","region":"DE","regex":"^https?://(www\\.)?moevenpick-wein\\.de"},
      {"name":"mogani.de","region":"DE","regex":"^https?://(www\\.)?mogani\\.de"},
      {"name":"monamikids.de","region":"DE","regex":"^https?://(www\\.)?monamikids\\.de"},
      {"name":"money4mymobile.com","region":"UK","regex":"^https?://(www\\.)?money4mymobile\\.com"},
      {"name":"moneyclothing.com","region":"UK","regex":"^https?://(www\\.)?moneyclothing\\.com"},
      {"name":"monsterparties.co.uk","region":"UK","regex":"^https?://(www\\.)?monsterparties\\.co\\.uk"},
      {"name":"monsterzeug.de","region":"DE","regex":"^https?://(www\\.)?monsterzeug\\.de"},
      {"name":"montessori-shop.de","region":"US","regex":"^https?://(www\\.)?montessori-shop\\.de"},
      {"name":"more-and-more.de","region":"DE","regex":"^https?://(www\\.)?more-and-more\\.de"},
      {"name":"moss.co.uk","region":"UK","regex":"^https?://(www\\.)?moss\\.co\\.uk"},
      {"name":"motelrocks.com","region":"UK","regex":"^https?://(www\\.)?motelrocks\\.com"},
      {"name":"motivators.com","region":"US","regex":"^https?://(www\\.)?motivators\\.com"},
      {"name":"moviemars.com","region":"US","regex":"^https?://(www\\.)?moviemars\\.com"},
      {"name":"multipoweruk.com","region":"UK","regex":"^https?://(www\\.)?multipoweruk\\.com"},
      {"name":"multizoneav.com","region":"UK","regex":"^https?://(www\\.)?multizoneav\\.com"},
      {"name":"murad.com","region":"US","regex":"^https?://(www\\.)?murad\\.com"},
      {"name":"muralsyourway.com","region":"US","regex":"^https?://(www\\.)?muralsyourway\\.com"},
      {"name":"musiciansfriend.com","region":"US","regex":"^https?://(www\\.)?musiciansfriend\\.com"},
      {"name":"musicianshut.com","region":"US","regex":"^https?://(www\\.)?musicianshut\\.com"},
      {"name":"mw-store.de","region":"US","regex":"^https?://(www\\.)?mw-store\\.de"},
      {"name":"mybodywear.de","region":"DE","regex":"^https?://(www\\.)?mybodywear\\.de"},
      {"name":"mychelle.com","region":"US","regex":"^https?://(www\\.)?mychelle\\.com"},
      {"name":"mydays.de","region":"DE","regex":"^https?://(www\\.)?mydays\\.de"},
      {"name":"myfavouritemagazines.co.uk","region":"UK","regex":"^https?://(www\\.)?myfavouritemagazines\\.co\\.uk"},
      {"name":"mynursinguniforms.com","region":"US","regex":"^https?://(www\\.)?mynursinguniforms\\.com"},
      {"name":"myownlabels.com","region":"US","regex":"^https?://(www\\.)?myownlabels\\.com"},
      {"name":"myparadise.de","region":"US","regex":"^https?://(www\\.)?myparadise\\.de"},
      {"name":"mypix.com","region":"UK","regex":"^https?://(www\\.)?mypix\\.com"},
      {"name":"mysteryguild.com","region":"US","regex":"^https?://(www\\.)?mysteryguild\\.com"},
      {"name":"mystore24hourfitness.com","region":"US","regex":"^https?://(www\\.)?mystore24hourfitness\\.com"},
      {"name":"mysupermarket.co.uk","region":"UK","regex":"^https?://(www\\.)?mysupermarket\\.co\\.uk"},
      {"name":"mytights.com","region":"UK","regex":"^https?://(www\\.)?mytights\\.com"},
      {"name":"myweddingfavors.com","region":"US","regex":"^https?://(www\\.)?myweddingfavors\\.com"},
      {"name":"napo-shop.de","region":"DE","regex":"^https?://(www\\.)?napo-shop\\.de"},
      {"name":"narscosmetics.com","region":"US","regex":"^https?://(www\\.)?narscosmetics\\.com"},
      {"name":"nasenbaershop.de","region":"DE","regex":"^https?://(www\\.)?nasenbaershop\\.de"},
      {"name":"nashbar.com","region":"US","regex":"^https?://(www\\.)?nashbar\\.com"},
      {"name":"nationaljeancompany.com","region":"US","regex":"^https?://(www\\.)?nationaljeancompany\\.com"},
      {"name":"nativeremedies.com","region":"US","regex":"^https?://(www\\.)?nativeremedies\\.com"},
      {"name":"naturalizer.com","region":"US","regex":"^https?://(www\\.)?naturalizer\\.com"},
      {"name":"naturideen.de","region":"DE","regex":"^https?://(www\\.)?naturideen\\.de"},
      {"name":"navigon.com","region":"US","regex":"^https?://(www\\.)?navigon\\.com"},
      {"name":"navishop.de","region":"US","regex":"^https?://(www\\.)?navishop\\.de"},
      {"name":"nawwrd.com","region":"US","regex":"^https?://(www\\.)?nawwrd\\.com"},
      {"name":"needapresent.com","region":"UK","regex":"^https?://(www\\.)?needapresent\\.com"},
      {"name":"neobuy.de","region":"US","regex":"^https?://(www\\.)?neobuy\\.de"},
      {"name":"nero.com","region":"US","regex":"^https?://(www\\.)?nero\\.com"},
      {"name":"netzoptiker.de","region":"DE","regex":"^https?://(www\\.)?netzoptiker\\.de"},
      {"name":"neuetischkultur.de","region":"US","regex":"^https?://(www\\.)?neuetischkultur\\.de"},
      {"name":"newlook.com","region":"UK","regex":"^https?://(www\\.)?newlook\\.com"},
      {"name":"newtonrunning.com","region":"US","regex":"^https?://(www\\.)?newtonrunning\\.com"},
      {"name":"nextbathrooms.co.uk","region":"UK","regex":"^https?://(www\\.)?nextbathrooms\\.co\\.uk"},
      {"name":"nici-shop.de","region":"DE","regex":"^https?://(www\\.)?nici-shop\\.de"},
      {"name":"nitroplanes.com","region":"US","regex":"^https?://(www\\.)?nitroplanes\\.com"},
      {"name":"nitrorcx.com","region":"US","regex":"^https?://(www\\.)?nitrorcx\\.com"},
      {"name":"nokia.com","region":"US","regex":"^https?://(www\\.)?nokia\\.com"},
      {"name":"nonstoppartner.net","region":"DE","regex":"^https?://(www\\.)?nonstoppartner\\.net"},
      {"name":"novica.com","region":"US","regex":"^https?://(www\\.)?novica\\.com"},
      {"name":"nunnbush.com","region":"US","regex":"^https?://(www\\.)?nunnbush\\.com"},
      {"name":"oakfurnitureland.co.uk","region":"UK","regex":"^https?://(www\\.)?oakfurnitureland\\.co\\.uk"},
      {"name":"oakstore.de","region":"US","regex":"^https?://(www\\.)?oakstore\\.de"},
      {"name":"oboy.de","region":"DE","regex":"^https?://(www\\.)?oboy\\.de"},
      {"name":"officedesigns.com","region":"US","regex":"^https?://(www\\.)?officedesigns\\.com"},
      {"name":"offtek.co.uk","region":"UK","regex":"^https?://(www\\.)?offtek\\.co\\.uk"},
      {"name":"okadirect.com","region":"UK","regex":"^https?://(www\\.)?okadirect\\.com"},
      {"name":"oldnavy.com","region":"US","regex":"^https?://(www\\.)?oldnavy\\.com"},
      {"name":"oldnavygap.com","region":"US","regex":"^https?://(www\\.)?oldnavygap\\.com"},
      {"name":"oldpueblotraders.com","region":"US","regex":"^https?://(www\\.)?oldpueblotraders\\.com"},
      {"name":"omronwebstore.com","region":"US","regex":"^https?://(www\\.)?omronwebstore\\.com"},
      {"name":"oncourtoffcourt.com","region":"US","regex":"^https?://(www\\.)?oncourtoffcourt\\.com"},
      {"name":"one.de","region":"DE","regex":"^https?://(www\\.)?one\\.de"},
      {"name":"onehanesplace.com","region":"US","regex":"^https?://(www\\.)?onehanesplace\\.com"},
      {"name":"onespirit.com","region":"US","regex":"^https?://(www\\.)?onespirit\\.com"},
      {"name":"onestopplus.com","region":"US","regex":"^https?://(www\\.)?onestopplus\\.com"},
      {"name":"onlinegolf.co.uk","region":"UK","regex":"^https?://(www\\.)?onlinegolf\\.co\\.uk"},
      {"name":"onlinesports.com","region":"US","regex":"^https?://(www\\.)?onlinesports\\.com"},
      {"name":"onmarketing.de","region":"US","regex":"^https?://(www\\.)?onmarketing\\.de"},
      {"name":"optikdrecker.de","region":"DE","regex":"^https?://(www\\.)?optikdrecker\\.de"},
      {"name":"optimalprint.de","region":"DE","regex":"^https?://(www\\.)?optimalprint\\.de"},
      {"name":"orchira.co.uk","region":"UK","regex":"^https?://(www\\.)?orchira\\.co\\.uk"},
      {"name":"organicbouquet.com","region":"US","regex":"^https?://(www\\.)?organicbouquet\\.com"},
      {"name":"organize.com","region":"US","regex":"^https?://(www\\.)?organize\\.com"},
      {"name":"origin.com","region":"US","regex":"^https?://(www\\.)?origin\\.com"},
      {"name":"otel.com","region":"US","regex":"^https?://(www\\.)?otel\\.com"},
      {"name":"outdoorgear.co.uk","region":"UK","regex":"^https?://(www\\.)?outdoorgear\\.co\\.uk"},
      {"name":"outletbuy.com","region":"US","regex":"^https?://(www\\.)?outletbuy\\.com"},
      {"name":"outletsc24.com","region":"US","regex":"^https?://(www\\.)?outletsc24\\.com"},
      {"name":"overkillshop.com","region":"DE","regex":"^https?://(www\\.)?overkillshop\\.com"},
      {"name":"overland.com","region":"US","regex":"^https?://(www\\.)?overland\\.com"},
      {"name":"overnightprints.com","region":"US","regex":"^https?://(www\\.)?overnightprints\\.com"},
      {"name":"ovuquick.de","region":"US","regex":"^https?://(www\\.)?ovuquick\\.de"},
      {"name":"pacochicano.com","region":"US","regex":"^https?://(www\\.)?pacochicano\\.com"},
      {"name":"paragonsports.com","region":"US","regex":"^https?://(www\\.)?paragonsports\\.com"},
      {"name":"parcel2go.com","region":"UK","regex":"^https?://(www\\.)?parcel2go\\.com"},
      {"name":"paretologic.com","region":"US","regex":"^https?://(www\\.)?paretologic\\.com"},
      {"name":"partmaster.co.uk","region":"UK","regex":"^https?://(www\\.)?partmaster\\.co\\.uk"},
      {"name":"partybox.co.uk","region":"UK","regex":"^https?://(www\\.)?partybox\\.co\\.uk"},
      {"name":"partydomain.co.uk","region":"UK","regex":"^https?://(www\\.)?partydomain\\.co\\.uk"},
      {"name":"partypaket.de","region":"DE","regex":"^https?://(www\\.)?partypaket\\.de"},
      {"name":"passion8.co.uk","region":"UK","regex":"^https?://(www\\.)?passion8\\.co\\.uk"},
      {"name":"pastacheese.com","region":"US","regex":"^https?://(www\\.)?pastacheese\\.com"},
      {"name":"patiofurnitureusaaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?patiofurnitureusaaffiliatetechnology\\.com"},
      {"name":"patriziapepe.com","region":"DE","regex":"^https?://(www\\.)?patriziapepe\\.com"},
      {"name":"pauschalreisenfti.de","region":"DE","regex":"^https?://(www\\.)?pauschalreisenfti\\.de"},
      {"name":"payless.com","region":"US","regex":"^https?://(www\\.)?payless\\.com"},
      {"name":"pda-square.de","region":"DE","regex":"^https?://(www\\.)?pda-square\\.de"},
      {"name":"peaceloveworld.com","region":"US","regex":"^https?://(www\\.)?peaceloveworld\\.com"},
      {"name":"peachpit.com","region":"US","regex":"^https?://(www\\.)?peachpit\\.com"},
      {"name":"peacocks.co.uk","region":"UK","regex":"^https?://(www\\.)?peacocks\\.co\\.uk"},
      {"name":"peartreegreetings.com","region":"US","regex":"^https?://(www\\.)?peartreegreetings\\.com"},
      {"name":"pegasusdesign24.de","region":"US","regex":"^https?://(www\\.)?pegasusdesign24\\.de"},
      {"name":"performancebike.com","region":"US","regex":"^https?://(www\\.)?performancebike\\.com"},
      {"name":"perfumecountry.com","region":"US","regex":"^https?://(www\\.)?perfumecountry\\.com"},
      {"name":"perfumeplusdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?perfumeplusdirect\\.co\\.uk"},
      {"name":"personalcreations.com","region":"US","regex":"^https?://(www\\.)?personalcreations\\.com"},
      {"name":"personalnovel.de","region":"DE","regex":"^https?://(www\\.)?personalnovel\\.de"},
      {"name":"personello.com","region":"DE","regex":"^https?://(www\\.)?personello\\.com"},
      {"name":"peruvianconnection.com","region":"US","regex":"^https?://(www\\.)?peruvianconnection\\.com"},
      {"name":"pet-source.com","region":"US","regex":"^https?://(www\\.)?pet-source\\.com"},
      {"name":"petcarechoice.com","region":"US","regex":"^https?://(www\\.)?petcarechoice\\.com"},
      {"name":"petnatur.de","region":"DE","regex":"^https?://(www\\.)?petnatur\\.de"},
      {"name":"petshop.de","region":"DE","regex":"^https?://(www\\.)?petshop\\.de"},
      {"name":"pfiffig-wohnen.de","region":"US","regex":"^https?://(www\\.)?pfiffig-wohnen\\.de"},
      {"name":"pflanzotheke.de","region":"DE","regex":"^https?://(www\\.)?pflanzotheke\\.de"},
      {"name":"pharmacyplace.co.uk","region":"UK","regex":"^https?://(www\\.)?pharmacyplace\\.co\\.uk"},
      {"name":"pharmaziedeutschland.com","region":"DE","regex":"^https?://(www\\.)?pharmaziedeutschland\\.com"},
      {"name":"phd-fitness.co.uk","region":"UK","regex":"^https?://(www\\.)?phd-fitness\\.co\\.uk"},
      {"name":"pheromone.de","region":"DE","regex":"^https?://(www\\.)?pheromone\\.de"},
      {"name":"philipmorrisdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?philipmorrisdirect\\.co\\.uk"},
      {"name":"philosophy.com","region":"US","regex":"^https?://(www\\.)?philosophy\\.com"},
      {"name":"phionbalance.com","region":"US","regex":"^https?://(www\\.)?phionbalance\\.com"},
      {"name":"physioroom.com","region":"UK","regex":"^https?://(www\\.)?physioroom\\.com"},
      {"name":"physiosupplies.com","region":"UK","regex":"^https?://(www\\.)?physiosupplies\\.com"},
      {"name":"picjay.com","region":"DE","regex":"^https?://(www\\.)?picjay\\.com"},
      {"name":"piercing-store.com","region":"DE","regex":"^https?://(www\\.)?piercing-store\\.com"},
      {"name":"pimkie.de","region":"DE","regex":"^https?://(www\\.)?pimkie\\.de"},
      {"name":"pinemeadowgolf.com","region":"US","regex":"^https?://(www\\.)?pinemeadowgolf\\.com"},
      {"name":"pinesolutions.co.uk","region":"UK","regex":"^https?://(www\\.)?pinesolutions\\.co\\.uk"},
      {"name":"piperlimegap.com","region":"US","regex":"^https?://(www\\.)?piperlimegap\\.com"},
      {"name":"plainlazy.com","region":"UK","regex":"^https?://(www\\.)?plainlazy\\.com"},
      {"name":"planet.co.uk","region":"UK","regex":"^https?://(www\\.)?planet\\.co\\.uk"},
      {"name":"plowhearth.com","region":"US","regex":"^https?://(www\\.)?plowhearth\\.com"},
      {"name":"plutosport.de","region":"DE","regex":"^https?://(www\\.)?plutosport\\.de"},
      {"name":"policestore.com","region":"US","regex":"^https?://(www\\.)?policestore\\.com"},
      {"name":"pooldawg.com","region":"US","regex":"^https?://(www\\.)?pooldawg\\.com"},
      {"name":"porzellanvitrine.de","region":"US","regex":"^https?://(www\\.)?porzellanvitrine\\.de"},
      {"name":"poshpet.de","region":"DE","regex":"^https?://(www\\.)?poshpet\\.de"},
      {"name":"post-a-rose.com","region":"UK","regex":"^https?://(www\\.)?post-a-rose\\.com"},
      {"name":"posterinxl.de","region":"DE","regex":"^https?://(www\\.)?posterinxl\\.de"},
      {"name":"postertaxi.de","region":"DE","regex":"^https?://(www\\.)?postertaxi\\.de"},
      {"name":"powerwatch.de","region":"DE","regex":"^https?://(www\\.)?powerwatch\\.de"},
      {"name":"pralinenwerkzeug.de","region":"US","regex":"^https?://(www\\.)?pralinenwerkzeug\\.de"},
      {"name":"preciousmomentsaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?preciousmomentsaffiliatetechnology\\.com"},
      {"name":"precis.co.uk","region":"UK","regex":"^https?://(www\\.)?precis\\.co\\.uk"},
      {"name":"preis24-online.de","region":"DE","regex":"^https?://(www\\.)?preis24-online\\.de"},
      {"name":"pressekatalog.de","region":"DE","regex":"^https?://(www\\.)?pressekatalog\\.de"},
      {"name":"prezziesplus.co.uk","region":"UK","regex":"^https?://(www\\.)?prezziesplus\\.co\\.uk"},
      {"name":"prezzybox.com","region":"UK","regex":"^https?://(www\\.)?prezzybox\\.com"},
      {"name":"pricelessshoes.co.uk","region":"UK","regex":"^https?://(www\\.)?pricelessshoes\\.co\\.uk"},
      {"name":"printerinks.com","region":"UK","regex":"^https?://(www\\.)?printerinks\\.com"},
      {"name":"printrunner.com","region":"US","regex":"^https?://(www\\.)?printrunner\\.com"},
      {"name":"private-nutrition.de","region":"DE","regex":"^https?://(www\\.)?private-nutrition\\.de"},
      {"name":"proboardshop.com","region":"US","regex":"^https?://(www\\.)?proboardshop\\.com"},
      {"name":"productsberries.com","region":"US","regex":"^https?://(www\\.)?productsberries\\.com"},
      {"name":"productscherrymoonfarms.com","region":"US","regex":"^https?://(www\\.)?productscherrymoonfarms\\.com"},
      {"name":"productsproflowers.com","region":"US","regex":"^https?://(www\\.)?productsproflowers\\.com"},
      {"name":"profirad.de","region":"US","regex":"^https?://(www\\.)?profirad\\.de"},
      {"name":"prohealth.com","region":"US","regex":"^https?://(www\\.)?prohealth\\.com"},
      {"name":"promod.de","region":"DE","regex":"^https?://(www\\.)?promod\\.de"},
      {"name":"promondo.de","region":"DE","regex":"^https?://(www\\.)?promondo\\.de"},
      {"name":"prosieben-fanshop.de","region":"DE","regex":"^https?://(www\\.)?prosieben-fanshop\\.de"},
      {"name":"providencejewelers.com","region":"US","regex":"^https?://(www\\.)?providencejewelers\\.com"},
      {"name":"pts-trading.de","region":"DE","regex":"^https?://(www\\.)?pts-trading\\.de"},
      {"name":"purelydiamonds.co.uk","region":"UK","regex":"^https?://(www\\.)?purelydiamonds\\.co\\.uk"},
      {"name":"puretea.de","region":"DE","regex":"^https?://(www\\.)?puretea\\.de"},
      {"name":"purminerals.com","region":"US","regex":"^https?://(www\\.)?purminerals\\.com"},
      {"name":"pv-holidays.com","region":"DE","regex":"^https?://(www\\.)?pv-holidays\\.com"},
      {"name":"pyramydair.com","region":"US","regex":"^https?://(www\\.)?pyramydair\\.com"},
      {"name":"qpb.com","region":"US","regex":"^https?://(www\\.)?qpb\\.com"},
      {"name":"quantis.de","region":"US","regex":"^https?://(www\\.)?quantis\\.de"},
      {"name":"quisma.com","region":"DE","regex":"^https?://(www\\.)?quisma\\.com"},
      {"name":"radley.co.uk","region":"UK","regex":"^https?://(www\\.)?radley\\.co\\.uk"},
      {"name":"rahmenversand.com","region":"US","regex":"^https?://(www\\.)?rahmenversand\\.com"},
      {"name":"raidentech.com","region":"US","regex":"^https?://(www\\.)?raidentech\\.com"},
      {"name":"rapidonline.com","region":"UK","regex":"^https?://(www\\.)?rapidonline\\.com"},
      {"name":"razorgator.com","region":"US","regex":"^https?://(www\\.)?razorgator\\.com"},
      {"name":"reconditionedtools.com","region":"US","regex":"^https?://(www\\.)?reconditionedtools\\.com"},
      {"name":"redcandy.co.uk","region":"UK","regex":"^https?://(www\\.)?redcandy\\.co\\.uk"},
      {"name":"redcarpetlingerie.com","region":"US","regex":"^https?://(www\\.)?redcarpetlingerie\\.com"},
      {"name":"redletterdays.co.uk","region":"UK","regex":"^https?://(www\\.)?redletterdays\\.co\\.uk"},
      {"name":"reebok.com","region":"DE","regex":"^https?://(www\\.)?reebok\\.com"},
      {"name":"reisennix-wie-weg.de","region":"DE","regex":"^https?://(www\\.)?reisennix-wie-weg\\.de"},
      {"name":"relaxtheback.com","region":"US","regex":"^https?://(www\\.)?relaxtheback\\.com"},
      {"name":"religioese-geschenke.de","region":"DE","regex":"^https?://(www\\.)?religioese-geschenke\\.de"},
      {"name":"reorderaclens.com","region":"US","regex":"^https?://(www\\.)?reorderaclens\\.com"},
      {"name":"reorderdiscountcontactlenses.com","region":"US","regex":"^https?://(www\\.)?reorderdiscountcontactlenses\\.com"},
      {"name":"rhapsodybookclub.com","region":"US","regex":"^https?://(www\\.)?rhapsodybookclub\\.com"},
      {"name":"ricaud.com","region":"US","regex":"^https?://(www\\.)?ricaud\\.com"},
      {"name":"richtig-schoen-kochen.de","region":"DE","regex":"^https?://(www\\.)?richtig-schoen-kochen\\.de"},
      {"name":"rickysnyc.com","region":"US","regex":"^https?://(www\\.)?rickysnyc\\.com"},
      {"name":"robertdyas.co.uk","region":"UK","regex":"^https?://(www\\.)?robertdyas\\.co\\.uk"},
      {"name":"rockdirect.com","region":"UK","regex":"^https?://(www\\.)?rockdirect\\.com"},
      {"name":"roommatespeelandstick.com","region":"US","regex":"^https?://(www\\.)?roommatespeelandstick\\.com"},
      {"name":"rosary.com","region":"US","regex":"^https?://(www\\.)?rosary\\.com"},
      {"name":"rosenbote.de","region":"US","regex":"^https?://(www\\.)?rosenbote\\.de"},
      {"name":"rossmannversand.de","region":"US","regex":"^https?://(www\\.)?rossmannversand\\.de"},
      {"name":"rosytec.com","region":"DE","regex":"^https?://(www\\.)?rosytec\\.com"},
      {"name":"roxio.com","region":"UK","regex":"^https?://(www\\.)?roxio\\.com"},
      {"name":"rucksack-center.de","region":"US","regex":"^https?://(www\\.)?rucksack-center\\.de"},
      {"name":"rumbatimeaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?rumbatimeaffiliatetechnology\\.com"},
      {"name":"rumcompany.de","region":"DE","regex":"^https?://(www\\.)?rumcompany\\.de"},
      {"name":"rumundco.de","region":"DE","regex":"^https?://(www\\.)?rumundco\\.de"},
      {"name":"runnersstore.de","region":"DE","regex":"^https?://(www\\.)?runnersstore\\.de"},
      {"name":"rushindustries.com","region":"US","regex":"^https?://(www\\.)?rushindustries\\.com"},
      {"name":"safetyglassesusa.com","region":"US","regex":"^https?://(www\\.)?safetyglassesusa\\.com"},
      {"name":"saltysupply.com","region":"US","regex":"^https?://(www\\.)?saltysupply\\.com"},
      {"name":"samuel-windsor.co.uk","region":"UK","regex":"^https?://(www\\.)?samuel-windsor\\.co\\.uk"},
      {"name":"sarenza.co.uk","region":"UK","regex":"^https?://(www\\.)?sarenza\\.co\\.uk"},
      {"name":"saverpoint.com","region":"UK","regex":"^https?://(www\\.)?saverpoint\\.com"},
      {"name":"saverstore.com","region":"UK","regex":"^https?://(www\\.)?saverstore\\.com"},
      {"name":"savilerowco.com","region":"US","regex":"^https?://(www\\.)?savilerowco\\.com"},
      {"name":"saxoprint.de","region":"DE","regex":"^https?://(www\\.)?saxoprint\\.de"},
      {"name":"scarpasaaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?scarpasaaffiliatetechnology\\.com"},
      {"name":"scentmonkey.com","region":"US","regex":"^https?://(www\\.)?scentmonkey\\.com"},
      {"name":"schatzinsel-schmuck.de","region":"DE","regex":"^https?://(www\\.)?schatzinsel-schmuck\\.de"},
      {"name":"schecker.de","region":"DE","regex":"^https?://(www\\.)?schecker\\.de"},
      {"name":"scottsmenswear.com","region":"UK","regex":"^https?://(www\\.)?scottsmenswear\\.com"},
      {"name":"screwfix.com","region":"UK","regex":"^https?://(www\\.)?screwfix\\.com"},
      {"name":"searsoutlet.com","region":"US","regex":"^https?://(www\\.)?searsoutlet\\.com"},
      {"name":"seasaltcornwall.co.uk","region":"UK","regex":"^https?://(www\\.)?seasaltcornwall\\.co\\.uk"},
      {"name":"seatwave.com","region":"UK","regex":"^https?://(www\\.)?seatwave\\.com"},
      {"name":"seatwave.de","region":"DE","regex":"^https?://(www\\.)?seatwave\\.de"},
      {"name":"sebago.com","region":"US","regex":"^https?://(www\\.)?sebago\\.com"},
      {"name":"secretsales.com","region":"UK","regex":"^https?://(www\\.)?secretsales\\.com"},
      {"name":"securechecksinthemail.com","region":"US","regex":"^https?://(www\\.)?securechecksinthemail\\.com"},
      {"name":"seeside.de","region":"DE","regex":"^https?://(www\\.)?seeside\\.de"},
      {"name":"selleros.com","region":"DE","regex":"^https?://(www\\.)?selleros\\.com"},
      {"name":"seniorenland.com","region":"US","regex":"^https?://(www\\.)?seniorenland\\.com"},
      {"name":"serversdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?serversdirect\\.co\\.uk"},
      {"name":"serviette.de","region":"DE","regex":"^https?://(www\\.)?serviette\\.de"},
      {"name":"sexylingerieshop.com","region":"US","regex":"^https?://(www\\.)?sexylingerieshop\\.com"},
      {"name":"sfbc.com","region":"US","regex":"^https?://(www\\.)?sfbc\\.com"},
      {"name":"sfpopsugar.com","region":"US","regex":"^https?://(www\\.)?sfpopsugar\\.com"},
      {"name":"sgd.de","region":"DE","regex":"^https?://(www\\.)?sgd\\.de"},
      {"name":"sheego.de","region":"DE","regex":"^https?://(www\\.)?sheego\\.de"},
      {"name":"sheloox.de","region":"DE","regex":"^https?://(www\\.)?sheloox\\.de"},
      {"name":"shirt66.de","region":"DE","regex":"^https?://(www\\.)?shirt66\\.de"},
      {"name":"shirtcity.de","region":"DE","regex":"^https?://(www\\.)?shirtcity\\.de"},
      {"name":"shoe-shop.com","region":"UK","regex":"^https?://(www\\.)?shoe-shop\\.com"},
      {"name":"shoebacca.com","region":"US","regex":"^https?://(www\\.)?shoebacca\\.com"},
      {"name":"shoebaccaaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?shoebaccaaffiliatetechnology\\.com"},
      {"name":"shoebuy.co.uk","region":"US","regex":"^https?://(www\\.)?shoebuy\\.co\\.uk"},
      {"name":"shoeline.com","region":"US","regex":"^https?://(www\\.)?shoeline\\.com"},
      {"name":"shoemall.com","region":"US","regex":"^https?://(www\\.)?shoemall\\.com"},
      {"name":"shoemanic.com","region":"US","regex":"^https?://(www\\.)?shoemanic\\.com"},
      {"name":"shoemetro.com","region":"US","regex":"^https?://(www\\.)?shoemetro\\.com"},
      {"name":"shoesandbags.de","region":"DE","regex":"^https?://(www\\.)?shoesandbags\\.de"},
      {"name":"shoesforcrews.com","region":"US","regex":"^https?://(www\\.)?shoesforcrews\\.com"},
      {"name":"shoon.com","region":"UK","regex":"^https?://(www\\.)?shoon\\.com"},
      {"name":"shop-apotheke.com","region":"US","regex":"^https?://(www\\.)?shop-apotheke\\.com"},
      {"name":"shop2market.com","region":"DE","regex":"^https?://(www\\.)?shop2market\\.com"},
      {"name":"shop3m.com","region":"US","regex":"^https?://(www\\.)?shop3m\\.com"},
      {"name":"shop4tech.com","region":"US","regex":"^https?://(www\\.)?shop4tech\\.com"},
      {"name":"shop4you.de","region":"US","regex":"^https?://(www\\.)?shop4you\\.de"},
      {"name":"shopadidas.de","region":"DE","regex":"^https?://(www\\.)?shopadidas\\.de"},
      {"name":"shopbop.com","region":"US","regex":"^https?://(www\\.)?shopbop\\.com"},
      {"name":"shopca.com","region":"US","regex":"^https?://(www\\.)?shopca\\.com"},
      {"name":"shopcallawaygolf.com","region":"US","regex":"^https?://(www\\.)?shopcallawaygolf\\.com"},
      {"name":"shopconfetti.co.uk","region":"UK","regex":"^https?://(www\\.)?shopconfetti\\.co\\.uk"},
      {"name":"shopdelonghi.com","region":"US","regex":"^https?://(www\\.)?shopdelonghi\\.com"},
      {"name":"shopdereon.com","region":"US","regex":"^https?://(www\\.)?shopdereon\\.com"},
      {"name":"shopdi.com","region":"US","regex":"^https?://(www\\.)?shopdi\\.com"},
      {"name":"shopdollhouse.com","region":"US","regex":"^https?://(www\\.)?shopdollhouse\\.com"},
      {"name":"shopelizabetharden.com","region":"US","regex":"^https?://(www\\.)?shopelizabetharden\\.com"},
      {"name":"shopfujitsu.com","region":"US","regex":"^https?://(www\\.)?shopfujitsu\\.com"},
      {"name":"shopghirardelli.com","region":"US","regex":"^https?://(www\\.)?shopghirardelli\\.com"},
      {"name":"shopgofalk.com","region":"US","regex":"^https?://(www\\.)?shopgofalk\\.com"},
      {"name":"shopgoldyn.com","region":"US","regex":"^https?://(www\\.)?shopgoldyn\\.com"},
      {"name":"shopkodak.co.uk","region":"UK","regex":"^https?://(www\\.)?shopkodak\\.co\\.uk"},
      {"name":"shopkodak.de","region":"DE","regex":"^https?://(www\\.)?shopkodak\\.de"},
      {"name":"shopleapfrog.com","region":"CA","regex":"^https?://(www\\.)?shopleapfrog\\.com"},
      {"name":"shopleapfrog.com","region":"US","regex":"^https?://(www\\.)?shopleapfrog\\.com"},
      {"name":"shoplegalseafoods.com","region":"US","regex":"^https?://(www\\.)?shoplegalseafoods\\.com"},
      {"name":"shoplego.com","region":"US","regex":"^https?://(www\\.)?shoplego\\.com"},
      {"name":"shoplenovo.com","region":"CA","regex":"^https?://(www\\.)?shoplenovo\\.com"},
      {"name":"shoplexware.de","region":"DE","regex":"^https?://(www\\.)?shoplexware\\.de"},
      {"name":"shopmagic-x.com","region":"US","regex":"^https?://(www\\.)?shopmagic-x\\.com"},
      {"name":"shopmandarinaduck.com","region":"US","regex":"^https?://(www\\.)?shopmandarinaduck\\.com"},
      {"name":"shopmanhattanite.com","region":"US","regex":"^https?://(www\\.)?shopmanhattanite\\.com"},
      {"name":"shopnastygal.com","region":"US","regex":"^https?://(www\\.)?shopnastygal\\.com"},
      {"name":"shopnewbalance.com","region":"US","regex":"^https?://(www\\.)?shopnewbalance\\.com"},
      {"name":"shoppacsun.com","region":"US","regex":"^https?://(www\\.)?shoppacsun\\.com"},
      {"name":"shoppuma.com","region":"US","regex":"^https?://(www\\.)?shoppuma\\.com"},
      {"name":"shopsavannahs.com","region":"UK","regex":"^https?://(www\\.)?shopsavannahs\\.com"},
      {"name":"shopscholastic.co.uk","region":"UK","regex":"^https?://(www\\.)?shopscholastic\\.co\\.uk"},
      {"name":"shopthebunny.com","region":"US","regex":"^https?://(www\\.)?shopthebunny\\.com"},
      {"name":"shopthermos.com","region":"US","regex":"^https?://(www\\.)?shopthermos\\.com"},
      {"name":"shopto.net","region":"UK","regex":"^https?://(www\\.)?shopto\\.net"},
      {"name":"shoptransparent.com","region":"US","regex":"^https?://(www\\.)?shoptransparent\\.com"},
      {"name":"shoptronics.com","region":"US","regex":"^https?://(www\\.)?shoptronics\\.com"},
      {"name":"shopuniqlo.com","region":"UK","regex":"^https?://(www\\.)?shopuniqlo\\.com"},
      {"name":"shopusacanon.com","region":"US","regex":"^https?://(www\\.)?shopusacanon\\.com"},
      {"name":"shopvans.com","region":"US","regex":"^https?://(www\\.)?shopvans\\.com"},
      {"name":"shopvodafone.co.uk","region":"UK","regex":"^https?://(www\\.)?shopvodafone\\.co\\.uk"},
      {"name":"shopwoodworking.com","region":"US","regex":"^https?://(www\\.)?shopwoodworking\\.com"},
      {"name":"shortorder.com","region":"US","regex":"^https?://(www\\.)?shortorder\\.com"},
      {"name":"si-city.com","region":"DE","regex":"^https?://(www\\.)?si-city\\.com"},
      {"name":"simpleshoes.com","region":"US","regex":"^https?://(www\\.)?simpleshoes\\.com"},
      {"name":"simplybe.co.uk","region":"UK","regex":"^https?://(www\\.)?simplybe\\.co\\.uk"},
      {"name":"simplybeach.com","region":"UK","regex":"^https?://(www\\.)?simplybeach\\.com"},
      {"name":"simplybunkbedsaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?simplybunkbedsaffiliatetechnology\\.com"},
      {"name":"simplyelectricals.co.uk","region":"UK","regex":"^https?://(www\\.)?simplyelectricals\\.co\\.uk"},
      {"name":"simplygames.com","region":"UK","regex":"^https?://(www\\.)?simplygames\\.com"},
      {"name":"simplyhe.co.uk","region":"UK","regex":"^https?://(www\\.)?simplyhe\\.co\\.uk"},
      {"name":"simplyhike.co.uk","region":"UK","regex":"^https?://(www\\.)?simplyhike\\.co\\.uk"},
      {"name":"simplypaving.com","region":"UK","regex":"^https?://(www\\.)?simplypaving\\.com"},
      {"name":"simplypiste.com","region":"UK","regex":"^https?://(www\\.)?simplypiste\\.com"},
      {"name":"simplyscuba.com","region":"UK","regex":"^https?://(www\\.)?simplyscuba\\.com"},
      {"name":"simplyswim.com","region":"UK","regex":"^https?://(www\\.)?simplyswim\\.com"},
      {"name":"simplyyouthministry.com","region":"US","regex":"^https?://(www\\.)?simplyyouthministry\\.com"},
      {"name":"sinclairintl.com","region":"US","regex":"^https?://(www\\.)?sinclairintl\\.com"},
      {"name":"sineros.de","region":"DE","regex":"^https?://(www\\.)?sineros\\.de"},
      {"name":"sitzclub.de","region":"DE","regex":"^https?://(www\\.)?sitzclub\\.de"},
      {"name":"size.co.uk","region":"UK","regex":"^https?://(www\\.)?size\\.co\\.uk"},
      {"name":"sizzix.com","region":"US","regex":"^https?://(www\\.)?sizzix\\.com"},
      {"name":"skechersaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?skechersaffiliatetechnology\\.com"},
      {"name":"skikesport.net","region":"DE","regex":"^https?://(www\\.)?skikesport\\.net"},
      {"name":"skilshop.com","region":"US","regex":"^https?://(www\\.)?skilshop\\.com"},
      {"name":"skinlight.co.uk","region":"UK","regex":"^https?://(www\\.)?skinlight\\.co\\.uk"},
      {"name":"skinsolutionstore.com","region":"US","regex":"^https?://(www\\.)?skinsolutionstore\\.com"},
      {"name":"slackline-corner.eu","region":"DE","regex":"^https?://(www\\.)?slackline-corner\\.eu"},
      {"name":"sleepingsolutions.co.uk","region":"UK","regex":"^https?://(www\\.)?sleepingsolutions\\.co\\.uk"},
      {"name":"sleepmasters.co.uk","region":"UK","regex":"^https?://(www\\.)?sleepmasters\\.co\\.uk"},
      {"name":"smartbargains.com","region":"US","regex":"^https?://(www\\.)?smartbargains\\.com"},
      {"name":"smartdestinations.com","region":"US","regex":"^https?://(www\\.)?smartdestinations\\.com"},
      {"name":"smarthome.com","region":"US","regex":"^https?://(www\\.)?smarthome\\.com"},
      {"name":"smdv.de","region":"DE","regex":"^https?://(www\\.)?smdv\\.de"},
      {"name":"smithandnoble.com","region":"US","regex":"^https?://(www\\.)?smithandnoble\\.com"},
      {"name":"snagacloseout.com","region":"US","regex":"^https?://(www\\.)?snagacloseout\\.com"},
      {"name":"snaptotes.com","region":"US","regex":"^https?://(www\\.)?snaptotes\\.com"},
      {"name":"sneakerspot.de","region":"DE","regex":"^https?://(www\\.)?sneakerspot\\.de"},
      {"name":"soape.com","region":"UK","regex":"^https?://(www\\.)?soape\\.com"},
      {"name":"socceraffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?socceraffiliatetechnology\\.com"},
      {"name":"sockshop.co.uk","region":"UK","regex":"^https?://(www\\.)?sockshop\\.co\\.uk"},
      {"name":"softsurroundings.com","region":"US","regex":"^https?://(www\\.)?softsurroundings\\.com"},
      {"name":"softsurroundingsoutlet.com","region":"US","regex":"^https?://(www\\.)?softsurroundingsoutlet\\.com"},
      {"name":"soliver.de","region":"DE","regex":"^https?://(www\\.)?soliver\\.de"},
      {"name":"sony.ca","region":"CA","regex":"^https?://(www\\.)?sony\\.ca"},
      {"name":"sowaswillichauch.de","region":"DE","regex":"^https?://(www\\.)?sowaswillichauch\\.de"},
      {"name":"space2.com","region":"UK","regex":"^https?://(www\\.)?space2\\.com"},
      {"name":"sparklingdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?sparklingdirect\\.co\\.uk"},
      {"name":"spartoo.co.uk","region":"UK","regex":"^https?://(www\\.)?spartoo\\.co\\.uk"},
      {"name":"spassbaron.de","region":"DE","regex":"^https?://(www\\.)?spassbaron\\.de"},
      {"name":"spencergiftsaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?spencergiftsaffiliatetechnology\\.com"},
      {"name":"spielzeug24.de","region":"US","regex":"^https?://(www\\.)?spielzeug24\\.de"},
      {"name":"spirithalloweenaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?spirithalloweenaffiliatetechnology\\.com"},
      {"name":"spiritline.com","region":"US","regex":"^https?://(www\\.)?spiritline\\.com"},
      {"name":"spiritofnature.co.uk","region":"UK","regex":"^https?://(www\\.)?spiritofnature\\.co\\.uk"},
      {"name":"sport-thieme.de","region":"DE","regex":"^https?://(www\\.)?sport-thieme\\.de"},
      {"name":"sportandleisureuk.com","region":"UK","regex":"^https?://(www\\.)?sportandleisureuk\\.com"},
      {"name":"sports-for-less.eu","region":"DE","regex":"^https?://(www\\.)?sports-for-less\\.eu"},
      {"name":"sportsflagsandpennants.com","region":"US","regex":"^https?://(www\\.)?sportsflagsandpennants\\.com"},
      {"name":"sportsshoes.com","region":"UK","regex":"^https?://(www\\.)?sportsshoes\\.com"},
      {"name":"spreadshirt.de","region":"DE","regex":"^https?://(www\\.)?spreadshirt\\.de"},
      {"name":"stacyadams.com","region":"US","regex":"^https?://(www\\.)?stacyadams\\.com"},
      {"name":"stagebeat.co.uk","region":"UK","regex":"^https?://(www\\.)?stagebeat\\.co\\.uk"},
      {"name":"stashtea.com","region":"US","regex":"^https?://(www\\.)?stashtea\\.com"},
      {"name":"staubsaugerbeutelshop.de","region":"DE","regex":"^https?://(www\\.)?staubsaugerbeutelshop\\.de"},
      {"name":"steelman24.com","region":"DE","regex":"^https?://(www\\.)?steelman24\\.com"},
      {"name":"steiner-verlagshaus.de","region":"US","regex":"^https?://(www\\.)?steiner-verlagshaus\\.de"},
      {"name":"stevesblindsandwallpaper.com","region":"US","regex":"^https?://(www\\.)?stevesblindsandwallpaper\\.com"},
      {"name":"stevia-crystal.com","region":"DE","regex":"^https?://(www\\.)?stevia-crystal\\.com"},
      {"name":"stickergiant.com","region":"US","regex":"^https?://(www\\.)?stickergiant\\.com"},
      {"name":"stilacosmetics.com","region":"US","regex":"^https?://(www\\.)?stilacosmetics\\.com"},
      {"name":"stilrichtung.de","region":"US","regex":"^https?://(www\\.)?stilrichtung\\.de"},
      {"name":"stoffwechselshop.de","region":"US","regex":"^https?://(www\\.)?stoffwechselshop\\.de"},
      {"name":"storado.de","region":"DE","regex":"^https?://(www\\.)?storado\\.de"},
      {"name":"stormwatches.com","region":"UK","regex":"^https?://(www\\.)?stormwatches\\.com"},
      {"name":"straighterline.com","region":"US","regex":"^https?://(www\\.)?straighterline\\.com"},
      {"name":"strawberryfool.co.uk","region":"UK","regex":"^https?://(www\\.)?strawberryfool\\.co\\.uk"},
      {"name":"stressnomore.co.uk","region":"UK","regex":"^https?://(www\\.)?stressnomore\\.co\\.uk"},
      {"name":"style369.com","region":"UK","regex":"^https?://(www\\.)?style369\\.com"},
      {"name":"stylebop.com","region":"US","regex":"^https?://(www\\.)?stylebop\\.com"},
      {"name":"stylebop.com","region":"US","regex":"^https?://(www\\.)?stylebop\\.com"},
      {"name":"stylefish.de","region":"DE","regex":"^https?://(www\\.)?stylefish\\.de"},
      {"name":"styleon.de","region":"US","regex":"^https?://(www\\.)?styleon\\.de"},
      {"name":"stylinonline.com","region":"US","regex":"^https?://(www\\.)?stylinonline\\.com"},
      {"name":"subsidesports.com","region":"UK","regex":"^https?://(www\\.)?subsidesports\\.com"},
      {"name":"subsidesports.de","region":"DE","regex":"^https?://(www\\.)?subsidesports\\.de"},
      {"name":"suitsmen.co.uk","region":"UK","regex":"^https?://(www\\.)?suitsmen\\.co\\.uk"},
      {"name":"sunandskiaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?sunandskiaffiliatetechnology\\.com"},
      {"name":"sunglassesuk.com","region":"UK","regex":"^https?://(www\\.)?sunglassesuk\\.com"},
      {"name":"superbiiz.com","region":"US","regex":"^https?://(www\\.)?superbiiz\\.com"},
      {"name":"superboleteria.com","region":"US","regex":"^https?://(www\\.)?superboleteria\\.com"},
      {"name":"superbreak.com","region":"UK","regex":"^https?://(www\\.)?superbreak\\.com"},
      {"name":"superdrug.com","region":"UK","regex":"^https?://(www\\.)?superdrug\\.com"},
      {"name":"supertrampdirect.co.uk","region":"UK","regex":"^https?://(www\\.)?supertrampdirect\\.co\\.uk"},
      {"name":"supplementstogo.com","region":"US","regex":"^https?://(www\\.)?supplementstogo\\.com"},
      {"name":"surfmountain.com","region":"UK","regex":"^https?://(www\\.)?surfmountain\\.com"},
      {"name":"swarovski-crystallized.com","region":"UK","regex":"^https?://(www\\.)?swarovski-crystallized\\.com"},
      {"name":"swarovski.com","region":"US","regex":"^https?://(www\\.)?swarovski\\.com"},
      {"name":"swarovski.com","region":"UK","regex":"^https?://(www\\.)?swarovski\\.com"},
      {"name":"swell.com","region":"US","regex":"^https?://(www\\.)?swell\\.com"},
      {"name":"swimspot.com","region":"US","regex":"^https?://(www\\.)?swimspot\\.com"},
      {"name":"swimsuitsforall.com","region":"US","regex":"^https?://(www\\.)?swimsuitsforall\\.com"},
      {"name":"swissoutpost.com","region":"US","regex":"^https?://(www\\.)?swissoutpost\\.com"},
      {"name":"switamin.com","region":"US","regex":"^https?://(www\\.)?switamin\\.com"},
      {"name":"szul.com","region":"US","regex":"^https?://(www\\.)?szul\\.com"},
      {"name":"tackenberg.de","region":"DE","regex":"^https?://(www\\.)?tackenberg\\.de"},
      {"name":"tattoosales.com","region":"US","regex":"^https?://(www\\.)?tattoosales\\.com"},
      {"name":"td-tracker.com","region":"US","regex":"^https?://(www\\.)?td-tracker\\.com"},
      {"name":"tdffashion.co.uk","region":"UK","regex":"^https?://(www\\.)?tdffashion\\.co\\.uk"},
      {"name":"technologyinthehome.com","region":"UK","regex":"^https?://(www\\.)?technologyinthehome\\.com"},
      {"name":"tedbaker.com","region":"UK","regex":"^https?://(www\\.)?tedbaker\\.com"},
      {"name":"teesforall.com","region":"US","regex":"^https?://(www\\.)?teesforall\\.com"},
      {"name":"teich-filter.eu","region":"US","regex":"^https?://(www\\.)?teich-filter\\.eu"},
      {"name":"teleflora.com","region":"US","regex":"^https?://(www\\.)?teleflora\\.com"},
      {"name":"telefone-fuer-senioren.de","region":"DE","regex":"^https?://(www\\.)?telefone-fuer-senioren\\.de"},
      {"name":"tennis-peters.de","region":"DE","regex":"^https?://(www\\.)?tennis-peters\\.de"},
      {"name":"terrific.de","region":"US","regex":"^https?://(www\\.)?terrific\\.de"},
      {"name":"terrysfabrics.co.uk","region":"UK","regex":"^https?://(www\\.)?terrysfabrics\\.co\\.uk"},
      {"name":"teufel.de","region":"DE","regex":"^https?://(www\\.)?teufel\\.de"},
      {"name":"teufelaudio.co.uk","region":"UK","regex":"^https?://(www\\.)?teufelaudio\\.co\\.uk"},
      {"name":"thebespokegiftcompany.co.uk","region":"UK","regex":"^https?://(www\\.)?thebespokegiftcompany\\.co\\.uk"},
      {"name":"thechildrenswearoutlet.com","region":"US","regex":"^https?://(www\\.)?thechildrenswearoutlet\\.com"},
      {"name":"thediamondstore.co.uk","region":"UK","regex":"^https?://(www\\.)?thediamondstore\\.co\\.uk"},
      {"name":"thedrinkshop.com","region":"UK","regex":"^https?://(www\\.)?thedrinkshop\\.com"},
      {"name":"thegoodcook.com","region":"US","regex":"^https?://(www\\.)?thegoodcook\\.com"},
      {"name":"thehairstyler.com","region":"US","regex":"^https?://(www\\.)?thehairstyler\\.com"},
      {"name":"thehipchick.com","region":"US","regex":"^https?://(www\\.)?thehipchick\\.com"},
      {"name":"theladen.de","region":"DE","regex":"^https?://(www\\.)?theladen\\.de"},
      {"name":"themenswearsite.com","region":"UK","regex":"^https?://(www\\.)?themenswearsite\\.com"},
      {"name":"therabreath.com","region":"US","regex":"^https?://(www\\.)?therabreath\\.com"},
      {"name":"thesilkhouse.eu","region":"US","regex":"^https?://(www\\.)?thesilkhouse\\.eu"},
      {"name":"thespacestore.com","region":"US","regex":"^https?://(www\\.)?thespacestore\\.com"},
      {"name":"thetoyshop.com","region":"UK","regex":"^https?://(www\\.)?thetoyshop\\.com"},
      {"name":"thewhiskyexchange.com","region":"UK","regex":"^https?://(www\\.)?thewhiskyexchange\\.com"},
      {"name":"thinkgeek.com","region":"US","regex":"^https?://(www\\.)?thinkgeek\\.com"},
      {"name":"thomaspink.com","region":"UK","regex":"^https?://(www\\.)?thomaspink\\.com"},
      {"name":"thompson-morgan.com","region":"UK","regex":"^https?://(www\\.)?thompson-morgan\\.com"},
      {"name":"thompsoncigar.com","region":"US","regex":"^https?://(www\\.)?thompsoncigar\\.com"},
      {"name":"thomson-line.de","region":"DE","regex":"^https?://(www\\.)?thomson-line\\.de"},
      {"name":"tickco.com","region":"US","regex":"^https?://(www\\.)?tickco\\.com"},
      {"name":"ticketliquidator.com","region":"US","regex":"^https?://(www\\.)?ticketliquidator\\.com"},
      {"name":"ticketnetwork.com","region":"US","regex":"^https?://(www\\.)?ticketnetwork\\.com"},
      {"name":"ties.com","region":"US","regex":"^https?://(www\\.)?ties\\.com"},
      {"name":"tigergps.com","region":"US","regex":"^https?://(www\\.)?tigergps\\.com"},
      {"name":"tightsplease.co.uk","region":"UK","regex":"^https?://(www\\.)?tightsplease\\.co\\.uk"},
      {"name":"timeformecatalog.com","region":"US","regex":"^https?://(www\\.)?timeformecatalog\\.com"},
      {"name":"timetospa.com","region":"US","regex":"^https?://(www\\.)?timetospa\\.com"},
      {"name":"tirerack.com","region":"US","regex":"^https?://(www\\.)?tirerack\\.com"},
      {"name":"titus.de","region":"DE","regex":"^https?://(www\\.)?titus\\.de"},
      {"name":"tmlewin.co.uk","region":"US","regex":"^https?://(www\\.)?tmlewin\\.co\\.uk"},
      {"name":"tmlewin.co.uk","region":"UK","regex":"^https?://(www\\.)?tmlewin\\.co\\.uk"},
      {"name":"tmlewin.com","region":"US","regex":"^https?://(www\\.)?tmlewin\\.com"},
      {"name":"tomsmithchristmascrackers.com","region":"US","regex":"^https?://(www\\.)?tomsmithchristmascrackers\\.com"},
      {"name":"tomtom.com","region":"US","regex":"^https?://(www\\.)?tomtom\\.com"},
      {"name":"toner-emstar.de","region":"DE","regex":"^https?://(www\\.)?toner-emstar\\.de"},
      {"name":"torquato.co.uk","region":"UK","regex":"^https?://(www\\.)?torquato\\.co\\.uk"},
      {"name":"torquato.de","region":"DE","regex":"^https?://(www\\.)?torquato\\.de"},
      {"name":"toshibadirect.com","region":"US","regex":"^https?://(www\\.)?toshibadirect\\.com"},
      {"name":"totally-funky.co.uk","region":"UK","regex":"^https?://(www\\.)?totally-funky\\.co\\.uk"},
      {"name":"toystars.de","region":"DE","regex":"^https?://(www\\.)?toystars\\.de"},
      {"name":"transitmuseumstore.com","region":"US","regex":"^https?://(www\\.)?transitmuseumstore\\.com"},
      {"name":"trash.de","region":"US","regex":"^https?://(www\\.)?trash\\.de"},
      {"name":"travelchannel.de","region":"DE","regex":"^https?://(www\\.)?travelchannel\\.de"},
      {"name":"tree2mydoor.com","region":"UK","regex":"^https?://(www\\.)?tree2mydoor\\.com"},
      {"name":"trendtimes.com","region":"US","regex":"^https?://(www\\.)?trendtimes\\.com"},
      {"name":"tribaluk.com","region":"UK","regex":"^https?://(www\\.)?tribaluk\\.com"},
      {"name":"trigema.de","region":"DE","regex":"^https?://(www\\.)?trigema\\.de"},
      {"name":"truffleshuffle.co.uk","region":"UK","regex":"^https?://(www\\.)?truffleshuffle\\.co\\.uk"},
      {"name":"trunki.co.uk","region":"UK","regex":"^https?://(www\\.)?trunki\\.co\\.uk"},
      {"name":"trustedtours.com","region":"US","regex":"^https?://(www\\.)?trustedtours\\.com"},
      {"name":"tshirthub.com","region":"US","regex":"^https?://(www\\.)?tshirthub\\.com"},
      {"name":"tshirtoutlet.com","region":"US","regex":"^https?://(www\\.)?tshirtoutlet\\.com"},
      {"name":"tsubo.com","region":"US","regex":"^https?://(www\\.)?tsubo\\.com"},
      {"name":"ttm-shop.de","region":"US","regex":"^https?://(www\\.)?ttm-shop\\.de"},
      {"name":"ttneckermann-reisen.de","region":"DE","regex":"^https?://(www\\.)?ttneckermann-reisen\\.de"},
      {"name":"tuifly.com","region":"US","regex":"^https?://(www\\.)?tuifly\\.com"},
      {"name":"tulle4us.com","region":"US","regex":"^https?://(www\\.)?tulle4us\\.com"},
      {"name":"tuneclub.de","region":"DE","regex":"^https?://(www\\.)?tuneclub\\.de"},
      {"name":"tylertool.com","region":"US","regex":"^https?://(www\\.)?tylertool\\.com"},
      {"name":"uhrendirect.de","region":"DE","regex":"^https?://(www\\.)?uhrendirect\\.de"},
      {"name":"uk.rochesterclothing.eu","region":"US","regex":"^https?://(www\\.)?uk\\.rochesterclothing\\.eu"},
      {"name":"ukeasyroommate.com","region":"UK","regex":"^https?://(www\\.)?ukeasyroommate\\.com"},
      {"name":"ukloccitane.com","region":"UK","regex":"^https?://(www\\.)?ukloccitane\\.com"},
      {"name":"ukoregonscientific.com","region":"UK","regex":"^https?://(www\\.)?ukoregonscientific\\.com"},
      {"name":"uksoccershop.com","region":"UK","regex":"^https?://(www\\.)?uksoccershop\\.com"},
      {"name":"uksofragrance.com","region":"UK","regex":"^https?://(www\\.)?uksofragrance\\.com"},
      {"name":"uksportimports.com","region":"UK","regex":"^https?://(www\\.)?uksportimports\\.com"},
      {"name":"ukstrawberrynet.com","region":"UK","regex":"^https?://(www\\.)?ukstrawberrynet\\.com"},
      {"name":"uktheatretickets.co.uk","region":"UK","regex":"^https?://(www\\.)?uktheatretickets\\.co\\.uk"},
      {"name":"ukwaterfeatures.com","region":"UK","regex":"^https?://(www\\.)?ukwaterfeatures\\.com"},
      {"name":"ukzenmed.com","region":"US","regex":"^https?://(www\\.)?ukzenmed\\.com"},
      {"name":"ulsterweavers.com","region":"UK","regex":"^https?://(www\\.)?ulsterweavers\\.com"},
      {"name":"ultimatebackstore.com","region":"US","regex":"^https?://(www\\.)?ultimatebackstore\\.com"},
      {"name":"umishoes.com","region":"US","regex":"^https?://(www\\.)?umishoes\\.com"},
      {"name":"unicum-koi.com","region":"US","regex":"^https?://(www\\.)?unicum-koi\\.com"},
      {"name":"unimall.de","region":"DE","regex":"^https?://(www\\.)?unimall\\.de"},
      {"name":"uniquepearl.com","region":"US","regex":"^https?://(www\\.)?uniquepearl\\.com"},
      {"name":"unisign.de","region":"US","regex":"^https?://(www\\.)?unisign\\.de"},
      {"name":"unitymedia.de","region":"DE","regex":"^https?://(www\\.)?unitymedia\\.de"},
      {"name":"unusual-kids.de","region":"DE","regex":"^https?://(www\\.)?unusual-kids\\.de"},
      {"name":"upandriding.com","region":"US","regex":"^https?://(www\\.)?upandriding\\.com"},
      {"name":"urban-stylistics.com","region":"DE","regex":"^https?://(www\\.)?urban-stylistics\\.com"},
      {"name":"urlaubsweltneckermann.de","region":"DE","regex":"^https?://(www\\.)?urlaubsweltneckermann\\.de"},
      {"name":"urlaubtravel3.de","region":"DE","regex":"^https?://(www\\.)?urlaubtravel3\\.de"},
      {"name":"usa4ink.com","region":"US","regex":"^https?://(www\\.)?usa4ink\\.com"},
      {"name":"usafrenchconnection.com","region":"US","regex":"^https?://(www\\.)?usafrenchconnection\\.com"},
      {"name":"usc.co.uk","region":"UK","regex":"^https?://(www\\.)?usc\\.co\\.uk"},
      {"name":"ushessnatur.com","region":"US","regex":"^https?://(www\\.)?ushessnatur\\.com"},
      {"name":"uspets.com","region":"US","regex":"^https?://(www\\.)?uspets\\.com"},
      {"name":"usstorecreative.com","region":"US","regex":"^https?://(www\\.)?usstorecreative\\.com"},
      {"name":"usstrawberrynet.com","region":"US","regex":"^https?://(www\\.)?usstrawberrynet\\.com"},
      {"name":"usthomaspink.com","region":"US","regex":"^https?://(www\\.)?usthomaspink\\.com"},
      {"name":"valentins.de","region":"DE","regex":"^https?://(www\\.)?valentins\\.de"},
      {"name":"valuemags.com","region":"US","regex":"^https?://(www\\.)?valuemags\\.com"},
      {"name":"versand2welten.de","region":"US","regex":"^https?://(www\\.)?versand2welten\\.de"},
      {"name":"versandapotheke-allgaeu.de","region":"US","regex":"^https?://(www\\.)?versandapotheke-allgaeu\\.de"},
      {"name":"vertbaudet.de","region":"DE","regex":"^https?://(www\\.)?vertbaudet\\.de"},
      {"name":"verwoehnwochenende.de","region":"US","regex":"^https?://(www\\.)?verwoehnwochenende\\.de"},
      {"name":"vfg.com","region":"DE","regex":"^https?://(www\\.)?vfg\\.com"},
      {"name":"vfg.com","region":"US","regex":"^https?://(www\\.)?vfg\\.com"},
      {"name":"viagogo.co.uk","region":"UK","regex":"^https?://(www\\.)?viagogo\\.co\\.uk"},
      {"name":"viagogo.de","region":"DE","regex":"^https?://(www\\.)?viagogo\\.de"},
      {"name":"viking.de","region":"DE","regex":"^https?://(www\\.)?viking\\.de"},
      {"name":"vilmarighishop.de","region":"DE","regex":"^https?://(www\\.)?vilmarighishop\\.de"},
      {"name":"vintagewinegifts.co.uk","region":"UK","regex":"^https?://(www\\.)?vintagewinegifts\\.co\\.uk"},
      {"name":"virginexperiencedays.co.uk","region":"UK","regex":"^https?://(www\\.)?virginexperiencedays\\.co\\.uk"},
      {"name":"virginiahayward.com","region":"UK","regex":"^https?://(www\\.)?virginiahayward\\.com"},
      {"name":"vistaprint.co.uk","region":"UK","regex":"^https?://(www\\.)?vistaprint\\.co\\.uk"},
      {"name":"vitamma.com","region":"US","regex":"^https?://(www\\.)?vitamma\\.com"},
      {"name":"volango.de","region":"DE","regex":"^https?://(www\\.)?volango\\.de"},
      {"name":"wall-art.de","region":"DE","regex":"^https?://(www\\.)?wall-art\\.de"},
      {"name":"wallis.co.uk","region":"UK","regex":"^https?://(www\\.)?wallis\\.co\\.uk"},
      {"name":"wandaufkleber.com","region":"US","regex":"^https?://(www\\.)?wandaufkleber\\.com"},
      {"name":"warehouse.co.uk","region":"UK","regex":"^https?://(www\\.)?warehouse\\.co\\.uk"},
      {"name":"watchco.com","region":"US","regex":"^https?://(www\\.)?watchco\\.com"},
      {"name":"watchmad.co.uk","region":"UK","regex":"^https?://(www\\.)?watchmad\\.co\\.uk"},
      {"name":"watchshop.com","region":"UK","regex":"^https?://(www\\.)?watchshop\\.com"},
      {"name":"waterfiltersaffiliatetechnology.com","region":"US","regex":"^https?://(www\\.)?waterfiltersaffiliatetechnology\\.com"},
      {"name":"wb-fernstudium.de","region":"DE","regex":"^https?://(www\\.)?wb-fernstudium\\.de"},
      {"name":"wbshop.com","region":"US","regex":"^https?://(www\\.)?wbshop\\.com"},
      {"name":"webroot.com","region":"US","regex":"^https?://(www\\.)?webroot\\.com"},
      {"name":"weforia.com","region":"US","regex":"^https?://(www\\.)?weforia\\.com"},
      {"name":"weinregalstein.de","region":"US","regex":"^https?://(www\\.)?weinregalstein\\.de"},
      {"name":"wellgosh.com","region":"UK","regex":"^https?://(www\\.)?wellgosh\\.com"},
      {"name":"westernshop.biz","region":"US","regex":"^https?://(www\\.)?westernshop\\.biz"},
      {"name":"westfalia.net","region":"US","regex":"^https?://(www\\.)?westfalia\\.net"},
      {"name":"westfalia.net","region":"UK","regex":"^https?://(www\\.)?westfalia\\.net"},
      {"name":"wetsuitwearhouse.com","region":"US","regex":"^https?://(www\\.)?wetsuitwearhouse\\.com"},
      {"name":"whitestuff.com","region":"UK","regex":"^https?://(www\\.)?whitestuff\\.com"},
      {"name":"wickes.co.uk","region":"UK","regex":"^https?://(www\\.)?wickes\\.co\\.uk"},
      {"name":"wilkinsonplus.com","region":"UK","regex":"^https?://(www\\.)?wilkinsonplus\\.com"},
      {"name":"willowridgecatalog.com","region":"US","regex":"^https?://(www\\.)?willowridgecatalog\\.com"},
      {"name":"windandweather.com","region":"US","regex":"^https?://(www\\.)?windandweather\\.com"},
      {"name":"windsmoor.co.uk","region":"UK","regex":"^https?://(www\\.)?windsmoor\\.co\\.uk"},
      {"name":"wineenthusiast.com","region":"US","regex":"^https?://(www\\.)?wineenthusiast\\.com"},
      {"name":"wineglobe.com","region":"US","regex":"^https?://(www\\.)?wineglobe\\.com"},
      {"name":"winterthurstore.com","region":"US","regex":"^https?://(www\\.)?winterthurstore\\.com"},
      {"name":"wirelessemporium.com","region":"US","regex":"^https?://(www\\.)?wirelessemporium\\.com"},
      {"name":"witt-weiden.de","region":"DE","regex":"^https?://(www\\.)?witt-weiden\\.de"},
      {"name":"wolfermans.com","region":"US","regex":"^https?://(www\\.)?wolfermans\\.com"},
      {"name":"wolfordshop.co.uk","region":"UK","regex":"^https?://(www\\.)?wolfordshop\\.co\\.uk"},
      {"name":"wolfordshop.com","region":"US","regex":"^https?://(www\\.)?wolfordshop\\.com"},
      {"name":"wolverine.com","region":"US","regex":"^https?://(www\\.)?wolverine\\.com"},
      {"name":"womensuits.com","region":"US","regex":"^https?://(www\\.)?womensuits\\.com"},
      {"name":"wonderful-kosmetik.de","region":"DE","regex":"^https?://(www\\.)?wonderful-kosmetik\\.de"},
      {"name":"woolovers.com","region":"UK","regex":"^https?://(www\\.)?woolovers\\.com"},
      {"name":"worldclassink.com","region":"US","regex":"^https?://(www\\.)?worldclassink\\.com"},
      {"name":"worldgallery.co.uk","region":"UK","regex":"^https?://(www\\.)?worldgallery\\.co\\.uk"},
      {"name":"wrangler.com","region":"US","regex":"^https?://(www\\.)?wrangler\\.com"},
      {"name":"wwsport.com","region":"US","regex":"^https?://(www\\.)?wwsport\\.com"},
      {"name":"wwstereo.com","region":"US","regex":"^https?://(www\\.)?wwstereo\\.com"},
      {"name":"www.eurolens.ie","region":"DE","regex":"^https?://(www\\.)?www\\.eurolens\\.ie"},
      {"name":"www.keller-sports.fr","region":"DE","regex":"^https?://(www\\.)?www\\.keller-sports\\.fr"},
      {"name":"www.manfrotto.us","region":"US","regex":"^https?://(www\\.)?www\\.manfrotto\\.us"},
      {"name":"www.shoesplease.de","region":"DE","regex":"^https?://(www\\.)?www\\.shoesplease\\.de"},
      {"name":"www.tintinstyle.se","region":"US","regex":"^https?://(www\\.)?www\\.tintinstyle\\.se"},
      {"name":"www.ufcstore.eu","region":"US","regex":"^https?://(www\\.)?www\\.ufcstore\\.eu"},
      {"name":"www.vfg-apotheke.at","region":"DE","regex":"^https?://(www\\.)?www\\.vfg-apotheke\\.at"},
      {"name":"wynsors.com","region":"UK","regex":"^https?://(www\\.)?wynsors\\.com"},
      {"name":"x8drums.com","region":"US","regex":"^https?://(www\\.)?x8drums\\.com"},
      {"name":"xergia.de","region":"DE","regex":"^https?://(www\\.)?xergia\\.de"},
      {"name":"xmx.de","region":"DE","regex":"^https?://(www\\.)?xmx\\.de"},
      {"name":"xperiencedays.com","region":"US","regex":"^https?://(www\\.)?xperiencedays\\.com"},
      {"name":"xtreamgadgets.com","region":"US","regex":"^https?://(www\\.)?xtreamgadgets\\.com"},
      {"name":"yancor.de","region":"DE","regex":"^https?://(www\\.)?yancor\\.de"},
      {"name":"yoga-clothing.com","region":"US","regex":"^https?://(www\\.)?yoga-clothing\\.com"},
      {"name":"yogoego.com","region":"UK","regex":"^https?://(www\\.)?yogoego\\.com"},
      {"name":"yoodoo.com","region":"UK","regex":"^https?://(www\\.)?yoodoo\\.com"},
      {"name":"youneek.com","region":"US","regex":"^https?://(www\\.)?youneek\\.com"},
      {"name":"your-design-shop.com","region":"US","regex":"^https?://(www\\.)?your-design-shop\\.com"},
      {"name":"your-lenses.de","region":"DE","regex":"^https?://(www\\.)?your-lenses\\.de"},
      {"name":"yourfavouritewines.com","region":"UK","regex":"^https?://(www\\.)?yourfavouritewines\\.com"},
      {"name":"yukka.co.uk","region":"UK","regex":"^https?://(www\\.)?yukka\\.co\\.uk"},
      {"name":"yvesrocherusa.com","region":"US","regex":"^https?://(www\\.)?yvesrocherusa\\.com"},
      {"name":"zagg.com","region":"US","regex":"^https?://(www\\.)?zagg\\.com"},
      {"name":"zaoza.de","region":"DE","regex":"^https?://(www\\.)?zaoza\\.de"},
      {"name":"zazzle.ca","region":"US","regex":"^https?://(www\\.)?zazzle\\.ca"},
      {"name":"zazzle.com","region":"US","regex":"^https?://(www\\.)?zazzle\\.com"},
      {"name":"zeitschriften-abo.de","region":"DE","regex":"^https?://(www\\.)?zeitschriften-abo\\.de"},
      {"name":"zephyrpaintball.com","region":"US","regex":"^https?://(www\\.)?zephyrpaintball\\.com"},
      {"name":"zestbeauty.com","region":"UK","regex":"^https?://(www\\.)?zestbeauty\\.com"},
      {"name":"zoelzer.de","region":"US","regex":"^https?://(www\\.)?zoelzer\\.de"},
      {"name":"zonkshop.com","region":"US","regex":"^https?://(www\\.)?zonkshop\\.com"},
      {"name":"zooplus.co.uk","region":"UK","regex":"^https?://(www\\.)?zooplus\\.co\\.uk"},
      {"name":"zugeschnuert-shop.de","region":"DE","regex":"^https?://(www\\.)?zugeschnuert-shop\\.de"},
      {"name":"zuneta.com","region":"UK","regex":"^https?://(www\\.)?zuneta\\.com"},
      {"name":"zungenpiercing.eu","region":"US","regex":"^https?://(www\\.)?zungenpiercing\\.eu"},
      {"name":"zurrose.de","region":"DE","regex":"^https?://(www\\.)?zurrose\\.de"},
      {"name":"ticketmaster.com", "region":"US","regex":"^https?://(www\\.)?ticketmaster\\.com"},
      {"name":"ticketmaster.co.uk" , "region":"UK","regex":"^https?://(www\\.)?ticketmaster\\.co.uk"},
      {"name":"seetickets.com" , "region":"UK","regex":"^https?://(www\\.)?seetickets\\.com"},
      {"name":"ents24.com" , "region":"UK","regex":"^https?://(www\\.)?ents24\\.com"},
      {"name":"viagogo.co.uk" , "region":"UK","regex":"^https?://(www\\.)?viagogo\\.co.uk"},
      {"name":"viagogo.com" , "region":"US","regex":"^https?://(www\\.)?viagogo\\.com"},
      {"name":"seatwave.com", "region":"US","regex":"^https?://(www\\.)?seatwave\\.com"},
      {"name":"tickets.com", "region":"US","regex":"^https?://(www\\.)?tickets\\.com"},
      {"name":"eventbrite.co.uk", "region":"UK","regex":"^https?://(www\\.)?eventbrite\\.co.uk"},
      {"name":"getmein.com", "region":"US","regex":"^https?://(www\\.)?getmein\\.com"},
      {"name":"fandango.com", "region":"US","regex":"^https?://(www\\.)?fandango\\.com"},
      {"name":"stubhub.com", "region":"US","regex":"^https?://(www\\.)?stubhub\\.com"},
      {"name":"ticketsnow.com", "region":"US","regex":"^https?://(www\\.)?ticketsnow\\.com"},
      {"name":"ticketliquidator.com", "region":"US","regex":"^https?://(www\\.)?ticketliquidator\\.com"},
      {"name":"songkick.com", "region":"US","regex":"^https?://(www\\.)?songkick\\.com"},
      {"name":"yelp.com", "region":"US","regex":"^https?://(www\\.)?yelp\\.com"},
      {"name":"yelp.co.uk", "region":"US","regex":"^https?://(www\\.)?yelp\\.co.uk"},
      {"name":"qype.co.uk", "region":"UK","regex":"^https?://(www\\.)?qype\\.co.uk"},
      {"name":"groupon.com", "region":"US","regex":"^https?://(www\\.)?groupon\\.com"},
      {"name":"groupon.co.uk", "region":"UK","regex":"^https?://(www\\.)?groupon\\.co.uk"},
      {"name":"britishgas.co.uk", "region":"UK","regex":"^https?://(www\\.)?britishgas.co.uk"},
      {"name":"eonenergy.co.uk", "region":"UK","regex":"^https?://(www\\.)?eonenergy.com"},
      {"name":"savetodaysavetomorrow.com", "region":"UK","regex":"^https?://(www\\.)?savetodaysavetomorrow.com"},
      {"name":"npower.com", "region":"UK","regex":"^https?://(www\\.)?npower.com"},
      {"name":"scottishpower.co.uk", "region":"UK","regex":"^https?://(www\\.)?scottishpower.co.uk"},
      {"name":"southern-electric.co.uk", "region":"UK","regex":"^https?://(www\\.)?southern-electric.co.uk"},
      {"name":"swalec.co.uk", "region":"UK","regex":"^https?://(www\\.)?swalec.co.uk"},
      {"name":"hydro.co.uk", "region":"UK","regex":"^https?://(www\\.)?hydro.co.uk"},
      {"name":"sse.co.uk", "region":"UK","regex":"^https?://(www\\.)?sse.co.uk"},
      {"name":"atlantic.co.uk", "region":"UK","regex":"^https?://(www\\.)?atlantic.co.uk"},
      {"name":"mywebsearch.com", "region":"US","regex":"^https?://(.*)?mywebsearch.com"},
    ];
  },

  getUpcomingRetailer: function(address){
    var retailers = this.retailers();
    for (var i = 0; i < retailers.length; i++) {
      var r = retailers[i];
      if (r && address.match(new RegExp(r.regex), 'i')) {
        return r;
      }
    }
    return false;
  },

  notify: function(pageViewId){
    var upcomingRetailer = this.getUpcomingRetailer(this.browser.currentUrl());
    if (upcomingRetailer) {
      var params = {
        region: upcomingRetailer.region,
        browser: this.browser.browserType(),
        version: this.browser.extensionVersion(),
        src: this.extension.properties.source,
        retailer: upcomingRetailer.name,
        uid: this.extension.properties.uid,
        original_url: this.browser.currentUrl(),
        page_view_id : pageViewId,
        request_id: com.forward.invisiblehand.uuid()
      };

      var alternativeServer = this.regions[upcomingRetailer.region.toLowerCase()].server;
      var reportUpcomingRetailer = com.forward.invisiblehand.common.utils.buildUrl(alternativeServer + '/products/upcoming', params);
      this.browser.getUrl(reportUpcomingRetailer);
    }
  }
}
com.forward.invisiblehand.currentPage = function (retailers, options, browser, extension, relatedProducts) {
  this.retailer = retailers.getRetailer();
  this.url = this.fixUrlForPlay(browser.currentUrl());
  this.retailers = retailers;
  this.options = options;
  this.browser = browser;
  this.extension = extension;
  this.relatedProducts = relatedProducts;
  this.scrapeResult = {};
  this.alternative = {};
  this.alternativeFactory = new com.forward.invisiblehand.alternativeFactory(extension, relatedProducts, options);
}

com.forward.invisiblehand.currentPage.prototype = {

  price: function(){
    return this.scrapeResult.price;
  },

  fixUrlForPlay: function (url) {
    if (url.match(/play\.com.+(add|delete)=\d+/)) {
      url = url.replace(/(add|delete)=\d+/, '');
    }
    if (url.match(/expansys\.com.+(sbadd)=\d+/)){
      url = url.replace(/(sbadd)=\d+/, '');
    }
    return url;
  },

  invalidGenericScrape: function(scrape){
    return !scrape || !(scrape.asin || scrape.product_query) || !scrape.region
  },

  currentScrapeFailed: function(retailer, scrapeResult) {
    if (retailer.category == "search_engine")
      return !scrapeResult || !(scrapeResult.asin || scrapeResult.product_query);
    if (retailer.category == "generic")
      return this.invalidGenericScrape(scrapeResult);
    return !scrapeResult || !(scrapeResult.price || scrapeResult.title);
  },

  scrapePage: function(scrapingCallback) {
    this.alternative = this.alternativeFactory.alternativeFor(this.retailer, {scraping_address:this.url});
    var scrapeHandler = this.alternative.scrapeHandler(scrapingCallback);

    if (this.retailer.use_inner_html) {
      this.browser.getInnerHtml(scrapeHandler);
    } else {
      this.browser.getUrl(this.url, scrapeHandler);
    }
  },

  toJson: function(){
    return JSON.stringify(this.scrapeResult);
  },

  similarItemsCallback: function(items, notification){
    notification.sendMessage({relatedProducts: items});
  },

  fetchSimilarItems: function(notification){
    if (this.alternative.shouldFetchSimilarItems(this.scrapeResult)){
      var self = this;
      this.relatedProducts.fetchSimilarItems(self.scrapeResult.title, function(items){
        self.similarItemsCallback(items, notification);
      });
    }
  },

  scrape: function(callback) {
    if (!this.retailer) {
      return;
    }

    if (this.retailer.category == "search_engine" && !this.options['products-search-engines-enabled']) {
      com.forward.invisiblehand.log("Search engines have been disabled");
      return;
    }

    var self = this;
    var scrapeHandler = function(scrapeResult) {
      self.scrapeResult = scrapeResult;
      callback && callback(self.currentScrapeFailed(self.retailer, scrapeResult), self);
    };

    this.scrapePage(scrapeHandler);
  }

}
com.forward.invisiblehand.retailers = function (browser, domain) {
    this.browser = browser;
    this.retailersUrl = 'http://scrapers.' + domain + '/retailers';
    this.retailersCache = {};
}

com.forward.invisiblehand.retailers.prototype = {

  parseProductsData: function(parsedReply) {
    var regions = parsedReply.regions;
    var retailersList = this.parseRetailers(parsedReply.all_retailers, regions);
    com.forward.invisiblehand.log('Got: ' + retailersList.length + ' retailers');
    var productsData = {"regions" : regions, "genericRetailerObject" : parsedReply.generic, "retailersList" : retailersList}
    this.browser.cache("productsData", productsData);
    this.productsData = productsData;
  },

  fetchRetailers: function (callback) {
    com.forward.invisiblehand.log("Fetching retailers from server");
    var self = this;
    if (this.browser.browserType() != 'opera') { // special condition for opera
      this.browser.getUrl(this.retailersUrl, function(data) {
        self.parseProductsData(JSON.parse(data));
        if (callback) callback(self.retailers());
      });
    } else { // opera, taking scrapers from file
      this.parseProductsData(com.forward.scrapers.retailers);
      if (callback) callback(this.retailers());
    }
  },

  parseRetailers: function(fullRetailersList, regions){
    var retailersList = []
    for (var i=0; i < fullRetailersList.length; i++) {
      var retailer = fullRetailersList[i];
      if (retailer.region) {
        retailer.region = regions[retailer.region.toLowerCase()];
      }
      retailersList.push(retailer);
    }
    return retailersList;
  },

  regionFor: function(region_code){
    return this.productsData.regions[region_code];
  },

  retailers: function() {
    return this.productsData.retailersList;
  },

  genericRetailer: function() {
    return this.productsData.genericRetailerObject;
  },

  getRetailer: function(address, currentPage) {
    var region_code = currentPage ? currentPage.scrapeResult.region : undefined;
    address = address || this.browser.currentUrl();
    var retailer = this.findRetailer(address);
    if (!retailer && (address == this.browser.currentUrl())) {
      retailer = this.genericRetailer();
    }
    if (retailer && !retailer.region && region_code) {
      retailer.region = this.regionFor(region_code);
    }
    return retailer;
  },

  findRetailer: function(address){
    if (this.retailersCache[address]) return this.retailersCache[address];

    var retailers = this.retailers();
    if (!retailers) throw "The list of retailers must already have been fetched";
    for (var i = 0; i < retailers.length; i++) {
      var r = retailers[i];
      if (address.match(new RegExp(r.regex), 'i')) {
        this.retailersCache[address] = r;
        return r;
      }
    }
  },

  fetchCachedRetailers: function(callback) {
    var self = this;
    this.browser.cache("productsData", function(productsData) {
      if (productsData) {
        self.productsData = productsData;
        callback && callback(self.retailers());
      } else {
        self.fetchRetailers(callback);
      }
    });
  }

}
com.forward.invisiblehand.notification = function (browser, extension, retailers, relatedItems) {
  this.browser = browser;
  this.extension = extension;
  this.retailers = retailers;
  this.relatedItems = relatedItems;
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.iFrameAddress = "http://productsiframe." + domain + "/?tracking_code=" + extension.properties.trackingCode;
}

com.forward.invisiblehand.notification.prototype = {

  showEarlyNotification: function(numberOfAlternatives){
    if(numberOfAlternatives >= 3) this.sendMessage({})
  },

  retailer: function(currentPage){
    return this.retailers.getRetailer(undefined, currentPage);
  },

  sendMessage: function(message) {
    var url = message.region ? this.iFrameAddress + "&region=" + message.region.code  : this.iFrameAddress;
    this.extension.showNotification(url, message, this.retailer().style_override);
  },

  sendCurrentPage: function(pageViewId, currentPage) {
    var reporting = {
      src                 : this.extension.installationSource(),
      retailer_name       : this.retailer().name,
      category            : this.retailer().category,
      uid                 : this.extension.properties.uid,
      browser             : this.browser.browserType(),
      page_view_id        : pageViewId
    }
    var message = {
      url: this.browser.currentUrl(),
      scrape: currentPage.scrapeResult,
      region: this.retailer(currentPage).region,
      reporting: reporting,
      settingsLink: this.extension.properties.settingsLink
    }
    this.sendMessage(message);
  }

}
com.forward.invisiblehand.retailerAlternatives = function (browser, extension, retailers, trackingCode, notification, relatedProducts, options) {
  this.browser = browser;
  this.extension = extension;
  this.retailers = retailers;
  this.relatedProducts = relatedProducts;
  this.trackingCode = trackingCode || "ih";
  this.alternativesList = [];
  this.notification = notification;
  this.alternativeFactory = new com.forward.invisiblehand.alternativeFactory(extension, relatedProducts, options);
}

com.forward.invisiblehand.retailerAlternatives.prototype = {

  alternativesUrl: function(currentPage, pageViewId) {
    var params = {
      item_address: this.browser.currentUrl(),
      item_data: currentPage.toJson(),
      tracking_code: this.trackingCode,
      uid: this.extension.properties.uid,
      version: this.browser.extensionVersion(),
      page_view_id: pageViewId,
      request_id: com.forward.invisiblehand.uuid()
    };
    return this.alternativesServer(params, currentPage);
  },

  alternativesServer: function(params, currentPage) {
    var retailer = this.retailers.getRetailer(undefined, currentPage);
    return com.forward.invisiblehand.common.utils.buildUrl(retailer.region.server + '/products/alternatives', params);
  },

  alternatives: function() {
    return this.alternativesList || [];
  },

  fetchRetailerAlternatives: function(currentPage, pageViewId, callback){
    var self = this;
    var alternativesUrl = this.alternativesUrl(currentPage, pageViewId);
    com.forward.invisiblehand.log('Fetching alternatives from ' + alternativesUrl);

    this.browser.getUrl(alternativesUrl, function(response) {
      var alternatives = JSON.parse(response).alternatives;
      com.forward.invisiblehand.log("Got " + alternatives.length + " alternatives");
      self.notification.showEarlyNotification(alternatives.length);
      var alternativesList = [];
      for (var i = 0; i < alternatives.length; i++){
        var alternative = alternatives[i];
        var retailer = self.retailers.getRetailer(alternative.scraping_address);
        if (retailer) {
          alternativesList.push(self.alternativeFactory.alternativeFor(retailer, alternative));
        }
      }
      self.alternativesList = alternativesList;
      callback(alternativesList);
    });
  }

}
com.forward.invisiblehand.ebay = function (browser, retailers, extensionProperties) {
  this.browser = browser;
  this.retailers = retailers;
  this.trackingCode = extensionProperties.trackingCode || "ih";
  this.uid = extensionProperties.uid
}

com.forward.invisiblehand.ebay.prototype = {

  eBayAlternativesServer: function(params) {
    var retailer = this.retailers.getRetailer();
    return com.forward.invisiblehand.common.utils.buildUrl(retailer.region.server + '/products/ebay_alternative', params);
  },

  hasProductInfo: function(alternative) {
    return alternative && alternative.price && alternative.title;
  },

  fetchEbayAlternatives: function(currentPage, pageViewId, callback) {
    com.forward.invisiblehand.log("Fetching ebay alternatives..")
    var params = {
      item_address: currentPage.url,
      item_data: JSON.stringify(currentPage.scrapeResult),
      tracking_code: this.trackingCode,
      uid: this.uid,
      version: this.browser.extensionVersion(),
      page_view_id: pageViewId,
      request_id: com.forward.invisiblehand.uuid()
    };

    var self = this;
    this.browser.getUrl(this.eBayAlternativesServer(params), function(response) {
      var alternatives = JSON.parse(response).alternatives;
      var ebayAlternatives = [];
      for (var i = 0 ; i < alternatives.length ; i++) {
        var alternative = alternatives[i];
        if (self.hasProductInfo(alternative)) {
          var retailer = self.retailers.getRetailer(alternative.scraping_address);
          ebayAlternatives.push(new com.forward.invisiblehand.ebayAlternative(retailer, alternative));
        }
      }
      callback(ebayAlternatives);
    })
  }
}
com.forward.invisiblehand.products = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.options = options;
  this.extension = extension;
  this.browser = extension.browser;

  this.retailers = new com.forward.invisiblehand.retailers(extension.browser, domain);
  this.ebay = new com.forward.invisiblehand.ebay(extension.browser, this.retailers, extension.properties);
  this.relatedProducts = new com.forward.invisiblehand.relatedProducts(extension.browser, this.retailers);
  this.notification = new com.forward.invisiblehand.notification(extension.browser, extension, this.retailers, this.relatedProducts);
  this.retailerAlternatives = new com.forward.invisiblehand.retailerAlternatives(extension.browser, extension, this.retailers, extension.properties.trackingCode, this.notification, this.relatedProducts);
}

com.forward.invisiblehand.products.prototype = {

  scrapeCurrentPage: function(callback) {
    var currentPage = new com.forward.invisiblehand.currentPage(this.retailers, this.options, this.browser, this.extension, this.relatedProducts);
    currentPage.scrape(callback);
  },

  fetchAlternatives: function(pageViewId, currentPage, callback) {
    this.retailerAlternatives.fetchRetailerAlternatives(currentPage, pageViewId, callback);
    if (this.options['products-ebay-enabled'])
      this.ebay.fetchEbayAlternatives(currentPage, pageViewId, callback);
  },

  processAlternativePage: function(currentPage, alternative) {
    alternative.scrape(this.notification, currentPage);
  },

  run: function(){
    var self = this;
    self.retailers.fetchCachedRetailers(function(retailers) {
      var upcomingRetailers = new com.forward.invisiblehand.upcomingRetailers(self.retailers.productsData.regions, self.browser, self.extension);

      self.scrapeCurrentPage(function(err, currentPage) {
        var pageViewId = com.forward.invisiblehand.uuid();
        if (err) {
          if (currentPage.retailer.category == "generic") {
            upcomingRetailers.notify(pageViewId);
          }
          com.forward.invisiblehand.log("Scraping current page failed");
        } else {
          self.notification.sendCurrentPage(pageViewId, currentPage);
          self.fetchAlternatives(pageViewId, currentPage, function(alternatives) {
            for (var i=0; i < alternatives.length; i++) {
              self.processAlternativePage(currentPage, alternatives[i]);
            }
          });
          currentPage.fetchSimilarItems(self.notification);
        }
      });
    });
  }
}

com.forward.invisiblehand.amazonReviews = function (region_code, html) {
  this.region_code = region_code;
  this.html = html;
  this.reviews = {topReviews: []};
  this.maxReviews = 3;
  this.scrapingDelay = 300;
};

com.forward.invisiblehand.amazonReviews.prototype = {

  scrape: function (callback) {
    com.forward.invisiblehand.log("Starting scraping the reviews");
    var self = this;
    self.number_of_reviews_scrape(function() {
      com.forward.invisiblehand.log("Scraped the number");
      var averageRatingScrapingFunc = function() {
        self.average_rating_scrape(function() {
          com.forward.invisiblehand.log("Scraped average rating");
          var histogramScrapingFunc = function() {
            self.scrape_histogram(function() {
              com.forward.invisiblehand.log("Scraped histogram");
              self.reviewScrapingFunc = function(reviewNumber) {
                self.scrape_review(reviewNumber, function() {
                  com.forward.invisiblehand.log("Scraped review " + reviewNumber);
                  if (reviewNumber === self.maxReviews) {
                    com.forward.invisiblehand.log("Returning to common");
                    callback(self.reviews);
                  }
                });
              };
              setTimeout(function() {self.reviewScrapingFunc(1);}, self.scrapingDelay);
              setTimeout(function() {self.reviewScrapingFunc(2);}, self.scrapingDelay*2);
              setTimeout(function() {self.reviewScrapingFunc(3);}, self.scrapingDelay*3);
            });
          };
          setTimeout(histogramScrapingFunc, self.scrapingDelay);
        });
      };
      setTimeout(averageRatingScrapingFunc, self.scrapingDelay);
    });
  },

  first_match: function (regex) {
    var match = null;
    try {
      match = this.html.match(regex);
    } catch(e) {}
    if (match == null) {
      return '';
    }
    return match[1].replace(/(")/g, '\'');
  },

  number_of_reviews_scrape: function (callback) {
    var regex = (this.region_code == 'DE') ?
      />(\d,\d{3}|\d{1,3}) Rezensionen/i :
      />(\d,\d{3}|\d{1,3}) customer reviews/i;
    var num_reviews = this.first_match(regex);
    if (num_reviews) {
      this.reviews.number = parseInt(num_reviews.replace(/,/, ''));
    } else {
      this.reviews.number = 0;
    }
    callback();
  },

  average_rating_scrape: function (callback) {
    callback();
  },

  scrape_histogram: function (callback) {
    var result = [];
    for (var i = 0; i < 5; i++) {
      var regex = (this.region_code == 'DE') ?
        '>' + (5 - i) + ' Sterne<[\1-\uFFFF]+?>&nbsp;\\(([\\d,]+)\\)<' :
        '>' + (5 - i) + ' star<[\1-\uFFFF]+?>&nbsp;\\(([\\d,]+)\\)<';
      var stars = this.first_match(new RegExp(regex, 'i'));
      result.push(stars ? parseInt(stars.replace(/,/, '')) : 0)
    }
    this.reviews.histogram = result;
    callback();
  },

  scrape_review: function (number_in_the_list, callback) {
    var rating = this.scrape_review_rating(number_in_the_list);
    if (rating) this.reviews.topReviews[number_in_the_list-1] = { rating: rating, title: this.scrape_review_title(number_in_the_list), text: this.scrape_review_text(number_in_the_list) };
    callback();
  },

  buildPrefix : function (number_in_the_list) {
   var prefix = '';
    for (var i = 0; i < number_in_the_list; i++) {
      prefix += "<!-- BOUNDARY -->[\1-\uFFFF]+?";
    }
    return prefix;
  },

  scrape_review_rating: function (number_in_the_list) {
    var prefix = this.buildPrefix(number_in_the_list);
    var regex = (this.region_code == 'DE') ?
      prefix + '(\\d)\\.0 von 5 Sternen' :
      prefix + '(\\d)\\.0 out of 5 stars';
    var rating = this.first_match(new RegExp(regex, 'i'));
    if (rating) {
      return parseFloat(rating);
    }
    else {
      return 0;
    }
  },

  scrape_review_title: function (number_in_the_list) {
    var prefix = this.buildPrefix(number_in_the_list);
    var regex = prefix + '<b>(.+?)<';
    return this.first_match(new RegExp(regex, 'i'));
  },

  scrape_review_text: function (number_in_the_list) {
    var prefix = this.buildPrefix(number_in_the_list);
    var regex = (this.region_code == 'DE') ?
      prefix + 'Rezension bezieht sich auf(?:.*\\n)+?.+?div>(?:.*\\n){0,10}(?:\\n\\n|span>)(?:<br \\/>\\n?){0,3}(\\w[^{}=_<>\\n]{20,150}\\w)' :
      prefix + 'This review is from(?:.*\\n)+?.+?div>(?:.*\\n){0,10}(?:\\n\\n|span>)(?:<br \\/>\\n?){0,3}(\\w[^{}=_<>\\n]{20,150}\\w)';
    return this.first_match(new RegExp(regex));
  }

};
com.forward.invisiblehand.uuid = (function() {
  /*
  * Generate a RFC4122(v4) UUID
  *
  * Documentation at https://github.com/broofa/node-uuid
  */

  var BufferClass = typeof(Buffer) == 'function' ? Buffer : Array;

  var _buf = new BufferClass(16);

  var toString = [];
  var toNumber = {};
  for (var i = 0; i < 256; i++) {
    toString[i] = (i + 0x100).toString(16).substr(1);
    toNumber[toString[i]] = i;
  }

  function parse(s) {
    var buf = new BufferClass(16);
    var i = 0;
    s.toLowerCase().replace(/[0-9a-f][0-9a-f]/g, function(octet) {
      buf[i++] = toNumber[octet];
    });
    return buf;
  }

  function unparse(buf) {
    var tos = toString, b = buf;
    return tos[b[0]] + tos[b[1]] + tos[b[2]] + tos[b[3]] + '-' +
           tos[b[4]] + tos[b[5]] + '-' +
           tos[b[6]] + tos[b[7]] + '-' +
           tos[b[8]] + tos[b[9]] + '-' +
           tos[b[10]] + tos[b[11]] + tos[b[12]] +
           tos[b[13]] + tos[b[14]] + tos[b[15]];
  }

  var ff = 0xff;

  var useCrypto = this.crypto && crypto.getRandomValues;
  var rnds = useCrypto ? new Uint32Array(4) : new Array(4);

  function uuid(fmt, buf, offset) {
    var b = fmt != 'binary' ? _buf : (buf ? buf : new BufferClass(16));
    var i = buf && offset || 0;

    if (useCrypto) {
      crypto.getRandomValues(rnds);
    } else {
      rnds[0] = Math.random()*0x100000000;
      rnds[1] = Math.random()*0x100000000;
      rnds[2] = Math.random()*0x100000000;
      rnds[3] = Math.random()*0x100000000;
    }

    var r = rnds[0];
    b[i++] = r & ff;
    b[i++] = r>>>8 & ff;
    b[i++] = r>>>16 & ff;
    b[i++] = r>>>24 & ff;
    r = rnds[1];
    b[i++] = r & ff;
    b[i++] = r>>>8 & ff;
    b[i++] = r>>>16 & 0x0f | 0x40; // See RFC4122 sect. 4.1.3
    b[i++] = r>>>24 & ff;
    r = rnds[2];
    b[i++] = r & 0x3f | 0x80; // See RFC4122 sect. 4.4
    b[i++] = r>>>8 & ff;
    b[i++] = r>>>16 & ff;
    b[i++] = r>>>24 & ff;
    r = rnds[3];
    b[i++] = r & ff;
    b[i++] = r>>>8 & ff;
    b[i++] = r>>>16 & ff;
    b[i++] = r>>>24 & ff;

    return fmt === undefined ? unparse(b) : b;
  }

  uuid.parse = parse;
  uuid.unparse = unparse;
  uuid.BufferClass = BufferClass;

  return uuid;
})();
com.forward.invisiblehand.flights = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.extension = extension;
  this.browser = extension.browser;
  this.travelOperatorsUrl = 'http://scrapers.invisiblehand.co.uk/travel_operators';
  this.iFrameAddress = 'fly.' + domain;
  this.options = options;
}

com.forward.invisiblehand.flights.prototype = {

  travelOperators: function() {
    return this.travelOperatorsList;
  },

  parseTravelOperatorsData: function(parsedReply) {
    this.travelOperatorsList = parsedReply.operators;
    for (var i=0; i < this.travelOperatorsList.length; i++) {
      if (this.travelOperatorsList.region) this.travelOperatorsList.region = parsedReply.regions[this.travelOperatorsList.region.toLowerCase()];
    }
    com.forward.invisiblehand.log('Got: ' + this.travelOperatorsList.length + ' travel operators');
    this.browser.cache("travelOperatorsList", this.travelOperatorsList);
  },

  fetchTravelOperators: function(callback) {
    var self = this;
    var travelOperatorsList = this.travelOperators();
    if (!travelOperatorsList) {
      if (this.browser.browserType() != 'opera') { // special condition for opera
        this.browser.getUrl(this.travelOperatorsUrl, function(data) {
          self.parseTravelOperatorsData(JSON.parse(data));
          if (callback) callback(self.travelOperatorsList);
        });
      } else { // opera, taking scrapers from file
        this.parseTravelOperatorsData(com.forward.scrapers.travel_operators);
        if (callback) callback(this.travelOperatorsList);
      }
    } else {
      if (callback) callback(travelOperatorsList);
    }
  },

  consolidateStops: function(scrape) {
    if (!scrape) return;
    if (scrape.outbound_stops != null || scrape.return_stops != null)
      scrape.stops = (parseInt(scrape.outbound_stops) || 0) + (parseInt(scrape.return_stops) || 0);
  },

  scrapeCurrentPage: function(callback) {
    var self = this;
    var travelOperator = this.getTravelOperator();
    if (!travelOperator) {
      com.forward.invisiblehand.log("This is not a travel operator, skipping");
      return;
    }
    com.forward.invisiblehand.log("Scraping the travel operator");
    var scraper = this.extension.domScraper(travelOperator.scraper);
    scraper.scrape(function (scrape) {
      self.consolidateStops(scrape);
      com.forward.invisiblehand.log("Scraped: ");
      com.forward.invisiblehand.log(scrape);
      callback(self.processScrapeResults(scrape));
    });
  },

  processScrapeResults: function(scrape) {
    if (!scrape) return;
    if (!scrape.currency) {
      scrape.currency = this.detectCurrency(scrape.price);
    }
    scrape.price = this.cleanPrice(scrape.price);
    return scrape;
  },

  cleanPrice: function(price) {
    if (typeof price != 'string') return price;

    return price.replace(/[^\d\.]/g, "");
  },

  detectCurrency: function (price) {
    if (typeof price != 'string') return;

    var currencyMatches = {
      USD: [/USD/, /\$/],
      EUR: [/EUR/, /€/],
      GBP: [/GBP/, /£/]
    };

    for (currency in currencyMatches)
      for (var i = 0; i < currencyMatches[currency].length; i++)
        if (price.match(currencyMatches[currency][i]))
          return currency;


    var unknownCurrencyMatch = price.match(/[\d\.,]\s*([A-Z]{3})/) || price.match(/([A-Z]{3})\s*[,\d\.]+/);
    if (unknownCurrencyMatch) return unknownCurrencyMatch[1];

    return null;
  },

  getTravelOperator: function(address) {
    address = address || this.browser.currentUrl();
    var travelOperators = this.travelOperators();
    if (!travelOperators) throw "The list of travel operators must already have been fetched";
    for (var i = 0; i < travelOperators.length; i++) {
      var travelOperator = travelOperators[i];
      if (address.match(new RegExp(travelOperator.regex), 'i')) {
        return travelOperator;
      }
    }
    return null;
  },

  overridingStylesheet: function () {
    var travelOperator = this.getTravelOperator();
    return travelOperator.style_override;
  },

  showIFrame: function(scrape, address) {
    var travelOperator = this.getTravelOperator();

    var params = scrape;
    params.page_url       = this.browser.currentUrl();
    params.browser        = this.browser.browserType();
    params.window_height  = this.browser.windowHeight();
    params.src            = this.extension.properties.source;
    params.tracking_code  = this.extension.properties.trackingCode;
    params.acf              = this.extension.properties.uid; // acf is random and is just so that 'uid' doesn't appear on the URL

    var url = com.forward.invisiblehand.common.utils.buildUrl(this.iFrameAddress + '/' + address, params);
    var extraParams = null;
    this.extension.showNotification(url, extraParams, this.overridingStylesheet());
  },

  canShowNotification: function(scrape) {
    return scrape.depart_from && scrape.destination && scrape.departure_date; // scrape is undefined at times, do something about it
  },

  canShowSearchForm: function(scrape) {
    return scrape.depart_from || scrape.destination;
  },

  run: function() {
    var self = this;
    if (this.options['flights-enabled'] === false) {
      com.forward.invisiblehand.log("Flights are disabled");
      return;
    }
	this.browser.cache('travelOperatorsList', function(travelOperatorsList) {
	    self.travelOperatorsList = travelOperatorsList;
	   	self.fetchTravelOperators(function() {
	      self.scrapeCurrentPage(function(scrape) { // clean the results?
	        if (scrape) {
	          if (self.canShowNotification(scrape)) return self.showIFrame(scrape, 'notification');
	          if (self.canShowSearchForm(scrape))   return self.showIFrame(scrape, 'search');
	        }
	        com.forward.invisiblehand.log("Scraping of flights failed");
	      })
	    })
	});
    return true;
  }
}
com.forward.invisiblehand.hotels = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.extension = extension;
  this.browser = extension.browser;
  this.hotelsUrl = 'http://scrapers.invisiblehand.co.uk/hotels';
  this.iFrameAddress = 'hotels-iframe.' + domain;
  this.options = options;
}

com.forward.invisiblehand.hotels.prototype = {

  travelOperators: function() {
    return this.hotelsList;
  },

  parseHotelsData: function(parsedReply) {
    this.hotelsList = parsedReply.operators;
    for (var i=0; i < this.hotelsList.length; i++) {
      if (this.hotelsList.region) this.hotelsList.region = parsedReply.regions[this.hotelsList.region.toLowerCase()];
    }
    com.forward.invisiblehand.log('Got: ' + this.hotelsList.length + ' hotel sites');
    this.browser.cache("hotelsList", this.hotelsList);
  },

  fetchTravelOperators: function(callback) {
    var self = this;
    var hotelsList = this.travelOperators();
    if (!hotelsList) {
      if (this.browser.browserType() != 'opera') { // special condition for opera
        this.browser.getUrl(this.hotelsUrl, function(data) {
          self.parseHotelsData(JSON.parse(data));
          if (callback) callback(self.hotelsList);
        });
      } else { // opera, taking scrapers from file
        this.parseHotelsData(com.forward.scrapers.hotels);
        if (callback) callback(this.hotelsList);
      }
    } else {
      if (callback) callback(hotelsList);
    }
  },

  scrapeCurrentPage: function(callback) {
    var self = this;
    var travelOperator = this.getTravelOperator();
    if (!travelOperator) {
      com.forward.invisiblehand.log("This is not a hotel site, skipping");
      return;
    }
    com.forward.invisiblehand.log("Scraping the hotel site");
    var scraper = this.extension.domScraper(travelOperator.scraper);
    scraper.scrape(function (scrape) {
      com.forward.invisiblehand.log("Scraped: ");
      com.forward.invisiblehand.log(scrape);
      callback(self.processScrapeResults(scrape));
    });
  },

  processScrapeResults: function(scrape) {
    if (!scrape) return;
    return scrape;
  },

  getTravelOperator: function(address) {
    address = address || this.browser.currentUrl();
    var travelOperators = this.travelOperators();
    if (!travelOperators) throw "The list of travel operators must already have been fetched";
    for (var i = 0; i < travelOperators.length; i++) {
      var travelOperator = travelOperators[i];
      if (address.match(new RegExp(travelOperator.regex), 'i')) {
        return travelOperator;
      }
    }
    return null;
  },

  overridingStylesheet: function () {
    var travelOperator = this.getTravelOperator();
    return travelOperator.style_override;
  },

  showIFrame: function(scrape, address) {
    var travelOperator = this.getTravelOperator();

    var params = scrape;
    params.page_url       = this.browser.currentUrl();
    params.browser        = this.browser.browserType();
    params.region         = scrape.region || travelOperator.region;
    params.window_height  = this.browser.windowHeight();
    params.src            = this.extension.properties.source;
    params.tracking_code  = this.extension.properties.trackingCode;
    params.acf            = this.extension.properties.uid;
    params.site           = travelOperator.name;

    var url = com.forward.invisiblehand.common.utils.buildUrl(this.iFrameAddress + '/' + address, params);
    var message = { uid: params.acf, browser: params.browser, src: params.src, tracking_code: params.tracking_code, site: travelOperator.name, region: params.region };
    this.extension.showNotification(url, message, this.overridingStylesheet());
  },

  canShowNotification: function(scrape) {
    return scrape.checkin_date && scrape.checkout_date && scrape.location;
  },

  run: function() {
    var self = this;
    if (!this.options['flights-enabled']) {
      com.forward.invisiblehand.log("Flights (and hotels) are disabled");
      return;
    }
    this.browser.cache('hotelsList', function(hotelsList) {
      self.hotelsList = hotelsList;
      self.fetchTravelOperators(function() {
        self.scrapeCurrentPage(function(scrape) { // clean the results?
          if (scrape) {
            if (self.canShowNotification(scrape)) return self.showIFrame(scrape, 'notification');
          }
          com.forward.invisiblehand.log("Scraping of hotels failed");
        })
      })
    });
    return true;
  }
}
com.forward.invisiblehand.rentals = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.extension = extension;
  this.browser = extension.browser;
  this.rentalsUrl = 'http://scrapers.invisiblehand.co.uk/rentals';
  this.iFrameAddress = 'rentals-iframe.' + domain;
  this.options = options;
}

com.forward.invisiblehand.rentals.prototype = {

  travelOperators: function() {
    return this.rentalsList;
  },

  parseRentalsData: function(parsedReply) {
    this.rentalsList = parsedReply.operators;
    for (var i=0; i < this.rentalsList.length; i++) {
      if (this.rentalsList.region) this.rentalsList.region = parsedReply.regions[this.rentalsList.region.toLowerCase()];
    }
    com.forward.invisiblehand.log('Got: ' + this.rentalsList.length + ' rental sites');
    this.browser.cache("rentalsList", this.rentalsList);
  },

  fetchTravelOperators: function(callback) {
    var self = this;
    var rentalsList = this.travelOperators();
    if (!rentalsList) {
      if (this.browser.browserType() != 'opera') { // special condition for opera
        this.browser.getUrl(this.rentalsUrl, function(data) {
          self.parseRentalsData(JSON.parse(data));
          if (callback) callback(self.rentalsList);
        });
      } else { // opera, taking scrapers from file
        this.parseRentalsData(com.forward.scrapers.rentals);
        if (callback) callback(this.rentalsList);
      }
    } else {
      if (callback) callback(rentalsList);
    }
  },

  scrapeCurrentPage: function(callback) {
    var self = this;
    var travelOperator = this.getTravelOperator();
    if (!travelOperator) {
      com.forward.invisiblehand.log("This is not a rental site, skipping");
      return;
    }
    com.forward.invisiblehand.log("Scraping the rental site");
    var scraper = this.extension.domScraper(travelOperator.scraper);
    scraper.scrape(function (scrape) {
      com.forward.invisiblehand.log("Scraped: ");
      com.forward.invisiblehand.log(scrape);
      callback(scrape);
    });
  },

  getTravelOperator: function(address) {
    address = address || this.browser.currentUrl();
    var travelOperators = this.travelOperators();
    if (!travelOperators) throw "The list of travel operators must already have been fetched";
    for (var i = 0; i < travelOperators.length; i++) {
      var travelOperator = travelOperators[i];
      if (address.match(new RegExp(travelOperator.regex), 'i')) {
        return travelOperator;
      }
    }
    return null;
  },

  overridingStylesheet: function () {
    var travelOperator = this.getTravelOperator();
    return travelOperator.style_override;
  },

  showIFrame: function(scrape) {
    var travelOperator = this.getTravelOperator();

    var params = scrape;
    params.region         = travelOperator.region;
    params.page_url       = this.browser.currentUrl();
    params.browser        = this.browser.browserType();
    params.window_height  = this.browser.windowHeight();
    params.src            = this.extension.properties.source;
    params.tracking_code  = this.extension.properties.trackingCode;
    params.acf            = this.extension.properties.uid;

    var url = com.forward.invisiblehand.common.utils.buildUrl(this.iFrameAddress + '/notification', params);
    var message = { uid: params.acf, browser: params.browser, src: params.src, tracking_code: params.tracking_code, site: travelOperator.name };
    this.extension.showNotification(url, message, this.overridingStylesheet());
  },

  canShowNotification: function(scrape) {
    return scrape.checkin_date;
  },

  run: function() {
    var self = this;
    if (this.options['rentals-enabled'] === false) {
      com.forward.invisiblehand.log("Rentals are disabled");
      return;
    }
    this.browser.cache('rentalsList', function(rentalsList) {
      self.rentalsList = rentalsList;
      self.fetchTravelOperators(function() {
        self.scrapeCurrentPage(function(scrape) { // clean the results?
          if (scrape) {
            if (self.canShowNotification(scrape)) return self.showIFrame(scrape);
          }
          com.forward.invisiblehand.log("Scraping of rentals failed");
        })
      })
    });
    return true;
  }
}
com.forward.invisiblehand.tickets = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.extension = extension;
  this.browser = extension.browser;
  this.ticketsUrl = 'http://scrapers.invisiblehand.co.uk/tickets';
  this.iFrameAddress = 'tickets-iframe.' + domain;
  this.options = options;
}

com.forward.invisiblehand.tickets.prototype = {

  ticketOperators: function() {
    return this.ticketsList;
  },

  parseTicketsData: function(parsedReply) {
    this.ticketsList = parsedReply.operators;
    for (var i=0; i < this.ticketsList.length; i++) {
      if (this.ticketsList.region) this.ticketsList.region = parsedReply.regions[this.ticketsList.region.toLowerCase()];
    }
    com.forward.invisiblehand.log('Got: ' + this.ticketsList.length + ' ticket sites');
    this.browser.cache("ticketsList", this.ticketsList);
  },

  fetchTicketOperators: function(callback) {
    var self = this;
    var ticketsList = this.ticketOperators();
    if (!ticketsList) {
      if (this.browser.browserType() != 'opera') { // special condition for opera
        this.browser.getUrl(this.ticketsUrl, function(data) {
          self.parseTicketsData(JSON.parse(data));
          if (callback) callback(self.ticketsList);
        });
      } else { // opera, taking scrapers from file
        this.parseTicketsData(com.forward.scrapers.tickets);
        if (callback) callback(this.ticketsList);
      }
    } else {
      if (callback) callback(ticketsList);
    }
  },

  scrapeCurrentPage: function(callback) {
    var self = this;
    var ticketOperator = this.getTravelOperator();
    if (!ticketOperator) {
      com.forward.invisiblehand.log("This is not a ticket site, skipping");
      return;
    }
    com.forward.invisiblehand.log("Scraping the ticket site");
    var scraper = this.extension.domScraper(ticketOperator.scraper);
    scraper.scrape(function (scrape) {
      com.forward.invisiblehand.log("Scraped: ");
      com.forward.invisiblehand.log(scrape);
      callback(scrape);
    });
  },

  getTravelOperator: function(address) {
    address = address || this.browser.currentUrl();
    var ticketOperators = this.ticketOperators();
    if (!ticketOperators) throw "The list of ticket operators must already have been fetched";
    for (var i = 0; i < ticketOperators.length; i++) {
      var ticketOperator = ticketOperators[i];
      if (address.match(new RegExp(ticketOperator.regex), 'i')) {
        return ticketOperator;
      }
    }
    return null;
  },

  overridingStylesheet: function () {
    var ticketOperator = this.getTravelOperator();
    return ticketOperator.style_override;
  },

  showIFrame: function(scrape) {
    var ticketOperator = this.getTravelOperator();

    var params = scrape;
    params.region         = ticketOperator.region;
    params.page_url       = this.browser.currentUrl();
    params.browser        = this.browser.browserType();
    params.window_height  = this.browser.windowHeight();
    params.src            = this.extension.properties.source;
    params.tracking_code  = this.extension.properties.trackingCode;
    params.acf            = this.extension.properties.uid;

    var url = com.forward.invisiblehand.common.utils.buildUrl(this.iFrameAddress + '/notification', params);
    var message = { uid: params.acf, browser: params.browser, src: params.src, tracking_code: params.tracking_code, site: ticketOperator.name };
    this.extension.showNotification(url, message, this.overridingStylesheet());
  },

  canShowNotification: function(scrape) {
    return scrape.date && scrape.artist;
  },

  run: function() {
    var self = this;
    if (this.options['tickets-enabled'] === false) {
      com.forward.invisiblehand.log("tickets are disabled");
      return;
    }
    this.browser.cache('ticketsList', function(ticketsList) {
      self.ticketsList = ticketsList;
      self.fetchTicketOperators(function() {
        self.scrapeCurrentPage(function(scrape) { // clean the results?
          if (scrape) {
            if (self.canShowNotification(scrape)) return self.showIFrame(scrape);
          }
          com.forward.invisiblehand.log("Scraping of tickets failed");
        })
      })
    });
    return true;
  }
}
com.forward.invisiblehand.deals = function (extension, options) {
  var domain = extension.properties.domain || "invisiblehand.co.uk";
  this.extension = extension;
  this.browser = extension.browser;
  this.dealsUrl = 'http://scrapers.invisiblehand.co.uk/deals';
  this.iFrameAddress = 'deals-iframe.' + domain;
  this.options = options;
}

com.forward.invisiblehand.deals.prototype = {

  dealOperators: function() {
    return this.dealsList;
  },

  fetchTravelOperators: function(callback) {
    var self = this;
    var dealsList = this.dealOperators();
    if(!dealsList) {
      this.browser.getUrl(this.dealsUrl, function(data) {
        var parsedReply = JSON.parse(data);
        self.dealsList = parsedReply.operators;
        for (var i=0; i < self.dealsList.length; i++) {
          if (self.dealsList.region) self.dealsList.region = parsedReply.regions[self.dealsList.region.toLowerCase()];
        }
        com.forward.invisiblehand.log('Got: ' + self.dealsList.length + ' deal sites');
        self.browser.cache("dealsList", self.dealsList);
        if (callback) callback(self.dealsList);
      });
     } else {
      if (callback) callback(dealsList);
    }
  },

  scrapeCurrentPage: function(callback) {
    var self = this;
    var dealOperator = this.getTravelOperator();
    if (!dealOperator) {
      com.forward.invisiblehand.log("This is not a deal site, skipping");
      return;
    }
    com.forward.invisiblehand.log("Scraping the deal site");
    var scraper = this.extension.domScraper(dealOperator.scraper);
    scraper.scrape(function (scrape) {
      com.forward.invisiblehand.log("Scraped: ");
      com.forward.invisiblehand.log(scrape);
      callback(scrape);
    });
  },

  getTravelOperator: function(address) {
    address = address || this.browser.currentUrl();
    var dealOperators = this.dealOperators();
    if (!dealOperators) throw "The list of deal operators must already have been fetched";
    for (var i = 0; i < dealOperators.length; i++) {
      var dealOperator = dealOperators[i];
      if (address.match(new RegExp(dealOperator.regex), 'i')) {
        return dealOperator;
      }
    }
    return null;
  },

  overridingStylesheet: function () {
    var dealOperator = this.getTravelOperator();
    return dealOperator.style_override;
  },

  showIFrame: function(scrape) {
    var dealOperator = this.getTravelOperator();

    var params = scrape;
    params.region         = dealOperator.region;
    params.page_url       = this.browser.currentUrl();
    params.browser        = this.browser.browserType();
    params.window_height  = this.browser.windowHeight();
    params.src            = this.extension.properties.source;
    params.tracking_code  = this.extension.properties.trackingCode;
    params.acf            = this.extension.properties.uid;

    var url = com.forward.invisiblehand.common.utils.buildUrl(this.iFrameAddress + '/notification', params);
    var message = { uid: params.acf, browser: params.browser, src: params.src, tracking_code: params.tracking_code, site: dealOperator.name };
    this.extension.showNotification(url, message, this.overridingStylesheet());
  },

  canShowNotification: function(scrape) {
    return scrape.location && (scrape.category || scrape.search_category);
  },

  run: function() {
    var self = this;
    if (this.options['deals-enabled'] === false) {
      com.forward.invisiblehand.log("deals are disabled");
      return;
    }
	  this.browser.cache('dealsList', function(dealsList) {
	    self.dealsList = dealsList;
	   	self.fetchTravelOperators(function() {
	      self.scrapeCurrentPage(function(scrape) { // clean the results?
	        if (scrape) {
	          if (self.canShowNotification(scrape)) return self.showIFrame(scrape);
	        }
	        com.forward.invisiblehand.log("Scraping of deals failed");
	      })
	    })
	});
    return true;
  }
}
