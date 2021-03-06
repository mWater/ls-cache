/**
 * lscache library
 * Copyright (c) 2011, Pamela Fox
 * Modified by Clayton Grassick, 2014
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*jshint undef:true, browser:true */
/*global define */

/*

Stores keys in following format in local storage:

ls-cache:<bucket path>:<key>

e.g. 

ls-cache:/db:added_rows

Also stores optional expiry information:

ls-cache-expiry:<bucket path>:<key>

value is expiry time encoded 

Buckets are nestable. Returns the root bucket first.

Always stores objects, not strings only.

*/

// Prefix for all lscache keys
var CACHE_PREFIX = 'ls-cache:';

// Suffix for the key name on the expiration items in localStorage
var CACHE_EXPIRY_PREFIX = 'ls-cache-expiry:';

// expiration date radix (set to Base-36 for most space savings)
var EXPIRY_RADIX = 10;

// time resolution in minutes
var EXPIRY_UNITS = 60 * 1000;

// ECMAScript max Date (epoch + 1e8 days)
var MAX_DATE = Math.floor(8.64e15/EXPIRY_UNITS);

var cachedStorage;
var cachedJSON;
var cacheBucket = '';
var warnings = false;

/**
 * Returns the number of minutes since the epoch.
 * @return {number}
 */
function currentTime() {
  return Math.floor((new Date().getTime())/EXPIRY_UNITS);
}


function warn(message, err) {
  if (!warnings) return;
  if (!'console' in window || typeof window.console.warn !== 'function') return;
  window.console.warn("lscache - " + message);
  if (err) window.console.warn("lscache - The error was: " + err.message);
}

// Determines if localStorage is supported in the browser;
// result is cached for better performance instead of being run each time.
// Feature detection is based on how Modernizr does it;
// it's not straightforward due to FF4 issues.
// It's not run at parse-time as it takes 200ms in Android.
function supportsStorage() {
  var key = '__lscachetest__';
  var value = key;

  if (cachedStorage !== undefined) {
    return cachedStorage;
  }

  try {
    localStorage.setItem(key, value);
    localStorage.removeItem(key);
    cachedStorage = true;
  } catch (exc) {
    cachedStorage = false;
  }
  return cachedStorage;
}

// Determines if native JSON (de-)serialization is supported in the browser.
function supportsJSON() {
  /*jshint eqnull:true */
  if (cachedJSON === undefined) {
    cachedJSON = (window.JSON != null);
  }
  return cachedJSON;
}

function Bucket(path) {
  this.path = path;
  
  function fullKey(key) {
    return CACHE_PREFIX + path + ":" + key;
  }

  function getItem(key) {
    return localStorage.getItem(key);
  }

  function setItem(key, value) {
    // Fix for iPad issue - sometimes throws QUOTA_EXCEEDED_ERR on setItem.
    localStorage.removeItem(key);
    localStorage.setItem(key, value);
  }

  function removeItem(key) {
    localStorage.removeItem(key);
  }

  /**
   * Returns the full string for the localStorage expiration item.
   * @param {String} key
   * @return {string}
   */
  function expirationKey(key) {
    return CACHE_EXPIRY_PREFIX + path + ":" + key;
  }

  this.set = function(key, value, time) {
    if (!supportsStorage()) return;

    // Will fail if object is circular
    value = JSON.stringify(value);

    try {
      setItem(fullKey(key), value);
    } catch (e) {
      if (e.name === 'QUOTA_EXCEEDED_ERR' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.name === 'QuotaExceededError') {
        // If we exceeded the quota, then we will sort
        // by the expire time, and then remove the N oldest in ALL buckets
        // Non-expiring are left alone
        var storedKeys = [];
        var storedKey;
        for (var i = 0; i < localStorage.length; i++) {
          storedKey = localStorage.key(i);

          if (storedKey.indexOf(CACHE_EXPIRY_PREFIX) === 0) {
            var mainKey = CACHE_PREFIX + storedKey.substring(CACHE_EXPIRY_PREFIX.length);
            var expiration = getItem(storedKey);
            expiration = parseInt(expiration, EXPIRY_RADIX);

            storedKeys.push({
              key: mainKey,
              expirationKey: storedKey,
              size: (getItem(mainKey)||'').length + mainKey.length,
              expiration: expiration
            });
          }
        }
        // Sorts the keys with oldest expiration time last
        storedKeys.sort(function(a, b) { return (b.expiration-a.expiration); });

        // Pad targetSize to make sure that expiry key or other size differences
        // don't prevent storage
        var targetSize = (value||'').length + fullKey(key).length + 100; 
        while (storedKeys.length && targetSize > 0) {
          storedKey = storedKeys.pop();
          warn("Cache is full, removing item with key '" + key + "'");
          removeItem(storedKey.key);
          removeItem(storedKey.expirationKey);
          targetSize -= storedKey.size;
        }
        setItem(fullKey(key), value);
      }
      else {
        // Rethrow other exceptions
        throw e;
      }
    }

    // If a time is specified, store expiration info in localStorage
    if (time) {
      setItem(expirationKey(key), (currentTime() + time).toString(EXPIRY_RADIX));
    } else {
      // In case they previously set a time, remove that info from localStorage.
      removeItem(expirationKey(key));
    }
  }

  /**
   * Retrieves specified value from localStorage, if not expired.
   * @param {string} key
   * @return {string|Object}
   */
  this.get = function(key) {
    if (!supportsStorage()) return null;

    // Return the de-serialized item if not expired
    var exprKey = expirationKey(key);
    var expr = getItem(exprKey);

    if (expr) {
      var expirationTime = parseInt(expr, EXPIRY_RADIX);

      // Check if we should actually kick item out of storage
      if (currentTime() >= expirationTime) {
        removeItem(fullKey(key));
        removeItem(exprKey);
        return null;
      }
    }

    // De-serialize stored value
    var value = getItem(fullKey(key));
    return JSON.parse(value);
  },

  /**
   * Removes a value from localStorage.
   * Equivalent to 'delete' in memcache, but that's a keyword in JS.
   * @param {string} key
   */
  this.remove = function(key) {
    if (!supportsStorage()) return null;
    removeItem(fullKey(key));
    removeItem(expirationKey(key));
  }

  /**
   * Returns whether local storage is supported.
   * Currently exposed for testing purposes.
   * @return {boolean}
   */
  this.supported =  function() {
    return supportsStorage();
  }

  /**
   * Sets whether to display warnings when an item is removed from the cache or not.
   */
  this.enableWarnings = function(enabled) {
    warnings = enabled;
  }

  /**
   * Flushes all lscache items and expiry markers in current bucket without affecting rest of localStorage
   */
  this.flush = function() {
    if (!supportsStorage()) return;

    // Loop in reverse as removing items will change indices of tail
    for (var i = localStorage.length-1; i >= 0 ; --i) {
      var key = localStorage.key(i);
      if (key.indexOf(CACHE_PREFIX + this.path + ":") === 0) {
        localStorage.removeItem(key);
      }
      else if (key.indexOf(CACHE_EXPIRY_PREFIX + this.path + ":") === 0) {
        localStorage.removeItem(key);
      }
    }
  }

  /**
   * Flushes all lscache items and expiry markers in current bucket and descendents without affecting rest of localStorage
   */
  this.flushRecursive = function() {
    if (!supportsStorage()) return;

    // Loop in reverse as removing items will change indices of tail
    for (var i = localStorage.length-1; i >= 0 ; --i) {
      var key = localStorage.key(i);
      if (key.indexOf(CACHE_PREFIX + this.path) === 0) {
        localStorage.removeItem(key);
      }
      else if (key.indexOf(CACHE_EXPIRY_PREFIX + this.path) === 0) {
        localStorage.removeItem(key);
      }
    }
  }
  
  this.keys = function() {
    keyList = []

    for (var i = 0; i < localStorage.length; i++) {
      storedKey = localStorage.key(i);

      if (storedKey.indexOf(CACHE_EXPIRY_PREFIX + this.path + ":") === 0) {
        var key = storedKey.substring(CACHE_EXPIRY_PREFIX.length + this.path.length + 1);
        keyList.push(key);
      }
    }
    return keyList;
  }
}

Bucket.prototype.createBucket = function(path) {
  // URI-encode name
  return new Bucket(this.path + encodeURIComponent(path) + "/");
}

module.exports = new Bucket("/");
