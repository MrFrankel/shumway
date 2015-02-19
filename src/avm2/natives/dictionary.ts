/*
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module Shumway.AVM2.AS {
  import assert = Shumway.Debug.assert;
  import assertNotImplemented = Shumway.Debug.assertNotImplemented;
  import notImplemented = Shumway.Debug.notImplemented;
  import asCoerceString = Shumway.AVM2.Runtime.asCoerceString;
  import Namespace = Shumway.AVM2.ABC.Namespace;
  import throwError = Shumway.AVM2.Runtime.throwError;
  import clamp = Shumway.NumberUtilities.clamp;
  import asCheckVectorGetNumericProperty = Shumway.AVM2.Runtime.asCheckVectorGetNumericProperty;
  import asCheckVectorSetNumericProperty = Shumway.AVM2.Runtime.asCheckVectorSetNumericProperty;

  export module flash.utils {
    var _asGetProperty = Object.prototype.asGetProperty;
    var _asSetProperty = Object.prototype.asSetProperty;
    var _asCallProperty = Object.prototype.asCallProperty;
    var _asHasProperty = Object.prototype.asHasProperty;
    var _asHasOwnProperty = Object.prototype.asHasOwnProperty;
    var _asHasTraitProperty = Object.prototype.asHasTraitProperty;
    var _asDeleteProperty = Object.prototype.asDeleteProperty;
    var _asGetEnumerableKeys = Object.prototype.asGetEnumerableKeys;

    /**
     * TODO: We need a more robust Dictionary implementation that doesn't only give you back
     * string keys when enumerating.
     */
    export class Dictionary extends ASNative {
      static classInitializer: any = function() {
        var proto: any = Dictionary.prototype;
        ObjectUtilities.defineNonEnumerableProperty(proto, '$BgtoJSON', proto.toJSON);
      }

      public static isTraitsOrDynamicPrototype(value): boolean {
        return value === Dictionary.traitsPrototype || value === Dictionary.dynamicPrototype;
      }

      public static protocol: IProtocol = Dictionary.prototype;


      private map: WeakMap<any, any>;
      private keys: any [];
      private weakKeys: boolean;
      private primitiveMap: Object;

      constructor (weakKeys: boolean = false) {
        false && super();
        this.weakKeys = !!weakKeys;
        this.map = new WeakMap();
        if (!weakKeys) {
          this.keys = [];
        }
        this.primitiveMap = Object.create(null);
      }

      static makePrimitiveKey(key) {
        if (typeof key === "string" || typeof key === "number") {
          return key;
        }
        release || assert (typeof key === "object" || typeof key === "function", typeof key);
        return undefined;
      }

      toJSON() {
        return "Dictionary";
      }

      public asGetNumericProperty(name: number) {
        return this.asGetProperty(null, name, 0);
      }

      public asSetNumericProperty(name: number, value) {
        this.asSetProperty(null, name, 0, value);
      }

      public asGetProperty(namespaces: Namespace [], name: any, flags: number) {
        if (Dictionary.isTraitsOrDynamicPrototype(this)) {
          return _asGetProperty.call(this, namespaces, name, flags);
        }
        var key = Dictionary.makePrimitiveKey(name);
        if (key !== undefined) {
          return this.primitiveMap[<any>key];
        }
        return this.map.get(Object(name));
      }

      public asSetProperty(namespaces: Namespace [], name: any, flags: number, value: any) {
        if (Dictionary.isTraitsOrDynamicPrototype(this)) {
          return _asSetProperty.call(this, namespaces, name, flags, value);
        }
        var key = Dictionary.makePrimitiveKey(name);
        if (key !== undefined) {
          this.primitiveMap[<any>key] = value;
          return;
        }
        this.map.set(Object(name), value);
        if (!this.weakKeys && this.keys.indexOf(name) < 0) {
          this.keys.push(name);
        }
      }

      // TODO: Not implemented yet.
      // public asCallProperty(namesp aces: Namespace [], name: any, flags: number, isLex: boolean, args: any []) {
      //   notImplemented("asCallProperty");
      // }

      public asHasProperty(namespaces: Namespace [], name: any, flags: number) {
        if (Dictionary.isTraitsOrDynamicPrototype(this)) {
          return _asHasProperty.call(this, namespaces, name, flags);
        }
        var key = Dictionary.makePrimitiveKey(name);
        if (key !== undefined) {
          return <any>key in this.primitiveMap;
        }
        return this.map.has(Object(name));
      }

      public asDeleteProperty(namespaces: Namespace [], name: any, flags: number) {
        if (Dictionary.isTraitsOrDynamicPrototype(this)) {
          return _asDeleteProperty.call(this, namespaces, name, flags);
        }
        var key = Dictionary.makePrimitiveKey(name);
        if (key !== undefined) {
          delete this.primitiveMap[<any>key];
        }
        this.map.delete(Object(name));
        var i;
        if (!this.weakKeys && (i = this.keys.indexOf(name)) >= 0) {
          this.keys.splice(i, 1);
        }
        return true;
      }

      public asGetEnumerableKeys() {
        if (Dictionary.isTraitsOrDynamicPrototype(this)) {
          return _asGetEnumerableKeys.call(this);
        }
        var primitiveMapKeys = [];
        for (var k in this.primitiveMap) {
          primitiveMapKeys.push(k);
        }
        if (this.weakKeys) {
          // TODO implement workaround for flashx.textLayout.external.WeakRef
          return primitiveMapKeys; // assuming all weak ref objects are gone
        }
        return primitiveMapKeys.concat(this.keys);
      }
    }

    export var OriginalDictionary = Dictionary;
  }
}
