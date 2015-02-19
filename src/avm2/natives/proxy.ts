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
  import notImplemented = Shumway.Debug.notImplemented;
  import Namespace = Shumway.AVM2.ABC.Namespace;
  import Multiname = Shumway.AVM2.ABC.Multiname;
  import throwError = Shumway.AVM2.Runtime.throwError;

  export module flash.utils {
    var _asGetProperty = Object.prototype.asGetProperty;
    var _asSetProperty = Object.prototype.asSetProperty;
    var _asCallProperty = Object.prototype.asCallProperty;
    var _asHasProperty = Object.prototype.asHasProperty;
    var _asHasOwnProperty = Object.prototype.asHasOwnProperty;
    var _asHasTraitProperty = Object.prototype.asHasTraitProperty;
    var _asDeleteProperty = Object.prototype.asDeleteProperty;

    /**
     * The Proxy class lets you override the default behavior of ActionScript operations (such as retrieving and modifying properties) on an object.
     */
    export class Proxy extends ASNative {
      public static protocol: IProtocol = Proxy.prototype;

      native_getProperty(name) {
        throwError("IllegalOperationError", Errors.ProxyGetPropertyError);
      }

      native_setProperty() {
        throwError("IllegalOperationError", Errors.ProxySetPropertyError);
      }

      native_callProperty() {
        throwError("IllegalOperationError", Errors.ProxyCallPropertyError);
      }

      native_hasProperty() {
        throwError("IllegalOperationError", Errors.ProxyHasPropertyError);
      }

      native_deleteProperty() {
        throwError("IllegalOperationError", Errors.ProxyDeletePropertyError);
      }

      native_getDescendants() {
        throwError("IllegalOperationError", Errors.ProxyGetDescendantsError);
      }

      native_nextNameIndex() {
        throwError("IllegalOperationError", Errors.ProxyNextNameIndexError);
      }

      native_nextName() {
        throwError("IllegalOperationError", Errors.ProxyNextNameError);
      }

      native_nextValue() {
        throwError("IllegalOperationError", Errors.ProxyNextValueError);
      }

      public asGetProperty(namespaces: Namespace [], name: any, flags: number) {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          return _asGetProperty.call(self, namespaces, name, flags);
        }
        return _asCallProperty.call(self, [Namespace.PROXY], "getProperty", 0, false, [name]);
      }

      public asGetNumericProperty(name: number) {
        return this.asGetProperty(null, name, 0);
      }

      public asSetNumericProperty(name: number, value) {
        this.asSetProperty(null, name, 0, value);
      }

      public asSetProperty(namespaces: Namespace [], name: any, flags: number, value: any) {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          _asSetProperty.call(self, namespaces, name, flags, value);
          return;
        }
        _asCallProperty.call(self, [Namespace.PROXY], "setProperty", 0, false, [name, value]);
      }

      public asCallProperty(namespaces: Namespace [], name: any, flags: number, isLex: boolean, args: any []): any {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          return _asCallProperty.call(self, namespaces, name, flags, false, args);
        }
        return _asCallProperty.call(self, [Namespace.PROXY], "callProperty", 0, false, [name].concat(args));
      }

      public asHasProperty(namespaces: Namespace [], name: any, flags: number): any {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          return _asHasProperty.call(self, namespaces, name, flags);
        }
        return _asCallProperty.call(self, [Namespace.PROXY], "hasProperty", 0, false, [name]);
      }

      public asHasOwnProperty(namespaces: Namespace [], name: any, flags: number): any {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          return _asHasOwnProperty.call(self, namespaces, name, flags);
        }
        return _asCallProperty.call(self, [Namespace.PROXY], "hasProperty", 0, false, [name]);
      }

      public asDeleteProperty(namespaces: Namespace [], name: any, flags: number): any {
        var self: Object = this;
        if (_asHasTraitProperty.call(self, namespaces, name, flags)) {
          return _asDeleteProperty.call(self, namespaces, name, flags);
        }
        return _asCallProperty.call(self, [Namespace.PROXY], "deleteProperty", 0, false, [name]);
      }

      public asNextName(index: number): any {
        notImplemented("Proxy asNextName");
      }

      public asNextValue(index: number): any {
        notImplemented("Proxy asNextValue");
      }

      public asNextNameIndex(index: number): number {
        notImplemented("Proxy asNextNameIndex");
        return;
      }
    }

    export var OriginalProxy = Proxy;
  }
}
