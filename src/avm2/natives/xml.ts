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

/*
 NOTE ON E4X METHOD CALLS

 E4X specifies some magic when making calls on XML and XMLList values. If a
 callee is not found on an XMLList value and the list has only one XML
 child, then the call is delegated to that XML child. If a callee is not
 found on an XML value and that value has simple content, then the simple
 content is converted to a string value and the call is made on that string
 value.

 Here are the relevant texts from the spec section 11.2.2.1:

 "If no such property exists and base is an XMLList of size 1, CallMethod
 delegates the method invocation to the single property it contains. This
 treatment intentionally blurs the distinction between XML objects and XMLLists
 of size 1."

 "If no such property exists and base is an XML object containing no XML valued
 children (i.e., an attribute, leaf node or element with simple content),
 CallMethod attempts to delegate the method lookup to the string value
 contained in the leaf node. This treatment allows users to perform operations
 directly on the value of a leaf node without having to explicitly select it."

 NOTE ON E4X ANY NAME AND NAMESPACE

 E4X allows the names of the form x.*, x.ns::*, x.*::id and x.*::* and their
 attribute name counterparts x.@*, x.@ns::*, etc. These forms result in
 Multiname values with the name part equal to undefined in the case of an ANY
 name, and the namespace set being empty in the case of an ANY namespace.

 Note also,
 x.*
 is shorthand for
 x.*::*
 .

 */

module Shumway.AVM2.AS {
  import assertNotImplemented = Shumway.Debug.assertNotImplemented;
  import assert = Shumway.Debug.assert;
  import Multiname = Shumway.AVM2.ABC.Multiname;
  import notImplemented = Shumway.Debug.notImplemented;
  import asCoerceString = Shumway.AVM2.Runtime.asCoerceString;

  import defineNonEnumerableProperty = Shumway.ObjectUtilities.defineNonEnumerableProperty;
  import createPublicAliases = Shumway.ObjectUtilities.createPublicAliases;

  var _asGetProperty = Object.prototype.asGetProperty;
  var _asSetProperty = Object.prototype.asSetProperty;
  var _asCallProperty = Object.prototype.asCallProperty;
  var _asHasProperty = Object.prototype.asHasProperty;
  var _asHasOwnProperty = Object.prototype.asHasOwnProperty;
  var _asDeleteProperty = Object.prototype.asDeleteProperty;
  var _asGetEnumerableKeys = Object.prototype.asGetEnumerableKeys;

  function isXMLType(val: any): boolean {
    return (val instanceof AS.ASXML || val instanceof AS.ASXMLList);
  }

  // 10.1 ToString
  function toString(node) {
    if (!(node instanceof AS.ASXML)) {
      return String(node);
    }
    switch (node._kind) {
      case ASXMLKind.Text:
      case ASXMLKind.Attribute:
        return node._value;
      default:
        if (node.hasSimpleContent()) {
          var s = '';
          for (var i = 0; i < node._children.length; i++) {
            var child = node._children[i];
            if (child._kind === ASXMLKind.Comment ||
                child._kind === ASXMLKind.ProcessingInstruction)
            {
              continue;
            }
            s += toString(child);
          }
          return s;
        }
        return toXMLString(node);
    }
  }

  // 10.2.1.1 EscapeElementValue ( s )
  export function escapeElementValue(s: string): string {
    var i = 0, ch;
    while (i < s.length && (ch = s[i]) !== '&' && ch !== '<' && ch !== '>') {
      i++;
    }
    if (i >= s.length) {
      return s;
    }
    var buf = s.substring(0, i);
    while (i < s.length) {
      ch = s[i++];
      switch (ch) {
        case '&':
          buf += '&amp;';
          break;
        case '<':
          buf += '&lt;';
          break;
        case '>':
          buf += '&gt;';
          break;
        default:
          buf += ch;
          break;
      }
    }
    return buf;
  }

  // 10.2.1.2 EscapeAttributeValue ( s )
  export function escapeAttributeValue(s: string): string {
    var i = 0, ch;
    while (i < s.length && (ch = s[i]) !== '&' && ch !== '<' &&
           ch !== '\"' && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      i++;
    }
    if (i >= s.length) {
      return s;
    }
    var buf = s.substring(0, i);
    while (i < s.length) {
      ch = s[i++];
      switch (ch) {
        case '&':
          buf += '&amp;';
          break;
        case '<':
          buf += '&lt;';
          break;
        case '\"':
          buf += '&quot;';
          break;
        case '\n':
          buf += '&#xA;';
          break;
        case '\r':
          buf += '&#xD;';
          break;
        case '\t':
          buf += '&#x9;';
          break;
        default:
          buf += ch;
          break;
      }
    }
    return buf;
  }

  function isWhitespace(s: string, index: number) {
    var ch = s[index];
    return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
  }

  function trimWhitespaces(s: string): string {
    var i = 0;
    while (i < s.length && isWhitespace(s, i)) {
      i++;
    }
    if (i >= s.length) {
      return '';
    }
    var j = s.length - 1;
    while (isWhitespace(s, j)) {
      j--;
    }
    return i === 0 && j === s.length - 1 ? s : s.substring(i, j + 1);
  }

  var indentStringCache: string[] = [];
  function getIndentString(indent: number): string {
    if (indent > 0) {
      if (indentStringCache[indent] !== undefined) {
        return indentStringCache[indent];
      }
      var s = '';
      for (var i = 0; i < indent; i++) {
        s += ' ';
      }
      indentStringCache[indent] = s;
      return s;
    }
    return '';
  }

  function generateUniquePrefix(namespaces: ASNamespace[]) {
    var i = 1, newPrefix;
    while (true) {
      newPrefix = '_ns' + i;
      if (!namespaces.some(function (ns) { return ns.prefix == newPrefix; })) {
        break;
      }
      i++;
    }
    return newPrefix;
  }

  // 10.2 ToXMLString
  function toXMLString(node:any, ancestorNamespaces?: ASNamespace[], indentLevel?: number) {
    if (node === null || node === undefined) {
      throw new TypeError();
    }
    if (!(node instanceof ASXML)) {
      if (node instanceof ASXMLList) {
        // 10.2.2 ToXMLString Applied to the XMLList Type
        return node._children.map(function (childNode) {
          return toXMLString(childNode, ancestorNamespaces);
        }).join(ASXML.prettyPrinting ? '\n' : '');
      }
      return escapeElementValue(String(node));
    }

    var prettyPrinting = ASXML.prettyPrinting;

    // 10.2.1 ToXMLString Applied to the XML Type
    indentLevel |= 0;
    var s = prettyPrinting ? getIndentString(indentLevel) : '';

    var kind: ASXMLKind = node._kind;
    switch (kind) {
      // 4. If x.[[Class]] == "text",
      case ASXMLKind.Text:
        return prettyPrinting ?
          s + escapeElementValue(trimWhitespaces(node._value)) :
          escapeElementValue(node._value);
      // 5. If x.[[Class]] == "attribute", return the result of concatenating s and
      // EscapeAttributeValue(x.[[Value]])
      case ASXMLKind.Attribute:
        return s + escapeAttributeValue(node._value);
      // 6. If x.[[Class]] == "comment", return the result of concatenating s, the string "<!--",
      // x.[[Value]] and the string "-->"
      case ASXMLKind.Comment:
        return s + '<!--' + node._value + '-->';
      // 7 If x.[[Class]] == "processing-instruction", return the result of concatenating s, the
      // string "<?", x.[[Name]].localName, the space <SP> character, x.[[Value]] and the string
      // "?>"
      case ASXMLKind.ProcessingInstruction:
        return s + '<?' + node._name.localName + ' ' + node._value + '?>';
      default:
        release || assert(kind === ASXMLKind.Element);
        break;
    }

    ancestorNamespaces = ancestorNamespaces || [];
    var namespaceDeclarations = [];

    // 10. For each ns in x.[[InScopeNamespaces]]
    for (var i = 0; node._inScopeNamespaces && i < node._inScopeNamespaces.length; i++) {
      var nsPrefix = node._inScopeNamespaces[i].prefix;
      var nsUri = node._inScopeNamespaces[i].uri;
      if (ancestorNamespaces.every(function (ans) { return ans.uri != nsUri || ans.prefix != nsPrefix; })) {
        var ns1 = new AS.ASNamespace(nsPrefix, nsUri);
        namespaceDeclarations.push(ns1);
      }
    }
    // 11. For each name in the set of names consisting of x.[[Name]] and the name of each
    // attribute in x.[[Attributes]]
    var currentNamespaces = ancestorNamespaces.concat(namespaceDeclarations);
    var namespace = node._name.getNamespace(currentNamespaces);
    if (namespace.prefix === undefined) {
      // Let namespace.prefix be an arbitrary implementation defined namespace prefix, such that
      // there is no ns2 ∈ (AncestorNamespaces ∪ namespaceDeclarations) with namespace.prefix ==
      // ns2.prefix
      var newPrefix = generateUniquePrefix(currentNamespaces);
      var ns2 = new AS.ASNamespace(newPrefix, namespace.uri);
      // Let namespaceDeclarations = namespaceDeclarations ∪ { namespace }
      namespaceDeclarations.push(ns2);
      currentNamespaces.push(ns2);
    }

    // 12. Let s be the result of concatenating s and the string "<"
    // 13. If namespace.prefix is not the empty string,
    //   a. Let s be the result of concatenating s, namespace.prefix and the string ":"
    // 14. Let s be the result of concatenating s and x.[[Name]].localName
    var elementName = (namespace.prefix ? namespace.prefix + ':' : '') + node._name.localName;
    s += '<' + elementName;

    node._attributes && node._attributes.forEach(function (attr) {
      var name: ASQName = attr._name;
      var namespace = name.getNamespace(currentNamespaces);
      if (namespace.prefix === undefined) {
        // Let namespace.prefix be an arbitrary implementation defined namespace prefix, such that
        // there is no ns2 ∈ (AncestorNamespaces ∪ namespaceDeclarations) with namespace.prefix ==
        // ns2.prefix
        var newPrefix = generateUniquePrefix(currentNamespaces);
        var ns2 = new AS.ASNamespace(newPrefix, namespace.uri);
        // Let namespaceDeclarations = namespaceDeclarations ∪ { namespace }
        namespaceDeclarations.push(ns2);
        currentNamespaces.push(ns2);
      }
    });

    for (var i = 0; i < namespaceDeclarations.length; i++) {
      var namespace = namespaceDeclarations[i];
      var attributeName = namespace.prefix ? 'xmlns:' + namespace.prefix : 'xmlns';
      s += ' ' +  attributeName + '=\"' + escapeAttributeValue(namespace.uri) + '\"';
    }
    node._attributes && node._attributes.forEach(function (attr) {
      var name: ASQName = attr._name;
      var namespace = name.getNamespace(ancestorNamespaces);
      var attributeName = namespace.prefix ? namespace.prefix + ':' + name.localName : name.localName;
      s += ' ' +  attributeName + '=\"' + escapeAttributeValue(attr._value) + '\"';
    });

    // 17. If x.[[Length]] == 0
    if (node.length() === 0) {
      //   a. Let s be the result of concatenating s and "/>"
      s += '/>';
      //   b. Return s
      return s;
    }

    // 18. Let s be the result of concatenating s and the string ">"
    s += '>';
    // 19. Let indentChildren = ((x.[[Length]] > 1) or (x.[[Length]] == 1 and x[0].[[Class]] is not
    // equal to "text"))
    var indentChildren = node._children.length > 1 ||
        (node._children.length === 1 && node._children[0]._kind !== ASXMLKind.Text);
    var nextIndentLevel = (prettyPrinting && indentChildren) ?
      indentLevel + ASXML.prettyIndent : 0;

    node._children.forEach(function (childNode, i) {
      if (prettyPrinting && indentChildren) {
        s += '\n';
      }
      var child = toXMLString(childNode, currentNamespaces, nextIndentLevel);
      s += child;
    });
    if (prettyPrinting && indentChildren) {
      s += '\n' + getIndentString(indentLevel);
    }

    s += '</' + elementName + '>';
    return s;
  }


  // 10.3 ToXML
  function toXML(v) {
    if (v === null) {
      throw new TypeError(formatErrorMessage(Errors.ConvertNullToObjectError));
    }
    if (v === undefined) {
      throw new TypeError(formatErrorMessage(Errors.ConvertUndefinedToObjectError));
    }
    if (v instanceof ASXML) {
      return v;
    }
    if (v instanceof ASXMLList) {
      if (v._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLMarkupMustBeWellFormed);
      }
      return v._children[0];
    }
    // The E4X spec says we must throw a TypeError for non-Boolean, Number, or String objects.
    // Flash thinks otherwise.
    var x = xmlParser.parseFromString(asCoerceString(v));
    var length = x.length();
    if (length === 0) {
      return createXML(ASXMLKind.Text);
    }
    if (length === 1) {
      x._children[0]._parent = null;
      return x._children[0];
    }
    Runtime.throwError('TypeError', Errors.XMLMarkupMustBeWellFormed);
  }

  // 10.4 ToXMLList
  function toXMLList(value: any, targetList: ASXMLList): void {
    // toXMLList is supposed to just return value if it's an XMLList already. For optimization
    // purposes, we handle that case at the callsites.
    release || assert(!(value instanceof ASXMLList));
    if (value === null) {
      Runtime.throwError('TypeError', Errors.ConvertNullToObjectError);
    }
    if (value === undefined) {
      Runtime.throwError('TypeError', Errors.ConvertUndefinedToObjectError);
    }
    if (value instanceof ASXML) {
      targetList.append(value);
      return;
    }
    // The E4X spec says we must throw a TypeError for non-Boolean, Number, or String objects.
    // Flash thinks otherwise.
    var parentString = '<parent xmlns="' + escapeAttributeValue(ASXML.defaultNamespace) + '">' +
                       value + '</parent>';
    var x = toXML(parentString);
    var children = x._children;
    if (!children) {
      return;
    }
    for (var i = 0; i < children.length; i++) {
      var v = children[i];
      v._parent = null;
      targetList.append(v);
    }
  }

  // 10.5 ToAttributeName
  function toAttributeName(v): ASQName {
    if (v === undefined || v === null || typeof v === "boolean" || typeof v === "number") {
      Runtime.throwError('TypeError', Errors.ConvertUndefinedToObjectError);
    }
    if (typeof v === 'object') {
      if (v instanceof ASQName) {
        return new AS.ASQName(v.uri, v.localName, true);
      }
      if (Multiname.isQName(v)) {
        return ASQName.fromMultiname(v);
      }
    }
    v = toString(v);
    return new AS.ASQName(undefined, v, true);
  }
  // 10.6 ToXMLName
  function toXMLName(mn): ASQName {
    if (mn === undefined) {
      return new AS.ASQName('*');
    }
    // convert argument to a value of type AttributeName or a QName object
    // according to the following:
    if (typeof mn === 'object' && mn !== null) {
      if (mn instanceof ASQName) {
        // Object - If the input argument is a QName object,
        // return the input argument.
        return mn
      }
      if (Multiname.isQName(mn)) {
        // ... same as above plus
        // AttributeName - Return the input argument (no conversion).
        // AnyName - Return the result of calling ToXMLName("*")
        return ASQName.fromMultiname(mn);
      }
      var name: string;
      if (mn instanceof ASXML || mn instanceof ASXMLList) {
        // XML or XMLList - Convert the input argument to a string using
        // ToString
        name = toString(mn);
      } else if (mn instanceof Multiname) {
        name = mn.name; // ?? Can be two or none namespaces here
      } else {
        // Object - Otherwise, convert the input argument to a
        // string using ToString
        name = mn.toString();
      }
    } else if (typeof mn === 'string') {
      // String - Create a QName object or AttributeName from the String
      // as specified below in section 10.6.1. See below
      name = mn;
    } else {
      throw new TypeError();
    }
    // ... then convert the result to a QName object or AttributeName
    // as specified in section 10.6.1.
    if (name[0] === '@') {
      // If the first character of s is "@", ToXMLName creates an
      // AttributeName using the ToAttributeName operator.
      return toAttributeName(name.substring(1));
    }
    return new AS.ASQName(undefined, name, !!(mn.flags & ASQNameFlags.ATTR_NAME));
  }

  function isQNameAttribute(name: any): boolean {
    return name instanceof ASQName && !!(name.name.flags & ASQNameFlags.ATTR_NAME);
  }

  function prefixWithNamespace(namespaces, name, isAttribute: boolean) {
    if (!namespaces ||
        namespaces.length !== 1 ||
        !(namespaces[0] instanceof ASNamespace) ||
        (typeof name !== 'string' && name !== undefined)) {
      return name;
    }
    return new AS.ASQName(namespaces[0], name || '*', isAttribute);
  }

  // 12.1 GetDefaultNamespace
  function getDefaultNamespace(): ASNamespace {
    // The scope's default xml namespace is stored in XML.defaultNamespace
    // (see runtime.ts createInterpretedFunction)
    return new AS.ASNamespace("", ASXML.defaultNamespace);
  }

  // 13.1.2.1 isXMLName ( value )
  export function isXMLName(v) {
    try {
      var qn = new AS.ASQName(v);
    } catch (e) {
      return false;
    }
    // FIXME scan v to see if it is a valid lexeme and return false if not
    return true;
  }

  Shumway.AVM2.AS.Natives.isXMLName = isXMLName;

  function XMLParser() {
    function parseXml(s, sink) {
      var i = 0, scopes: any [] = [{
        namespaces: [],
        lookup: {
          "xmlns": 'http://www.w3.org/2000/xmlns/',
          "xml": 'http://www.w3.org/XML/1998/namespace'
        },
        inScopes: !ASXML.defaultNamespace ? [] : [{uri: ASXML.defaultNamespace, prefix: ''}],
        space: 'default',
        xmlns: (ASXML.defaultNamespace || '')
      }];
      function resolveEntities(s) {
        return s.replace(/&([^;]+);/g, function(all, entity) {
          if (entity.substring(0, 2) === '#x') {
            return String.fromCharCode(parseInt(entity.substring(2), 16));
          } else if(entity.substring(0,1) === '#') {
            return String.fromCharCode(parseInt(entity.substring(1), 10));
          }
          switch (entity) {
            case 'lt':
              return '<';
            case 'gt':
              return '>';
            case 'amp':
              return '&';
            case 'quot':
              return '\"';
          }
          // throw "Unknown entity: " + entity;
          return all;
        });
      }
      function isWhitespacePreserved(): boolean {
        for (var j = scopes.length - 1; j >= 0; --j) {
          if (scopes[j].space === "preserve") {
            return true;
          }
        }
        return false;
      }
      function lookupDefaultNs(): string {
        for (var j = scopes.length - 1; j >= 0; --j) {
          if ('xmlns' in scopes[j]) {
            return scopes[j].xmlns;
          }
        }
        return '';
      }
      function lookupNs(prefix: string): string {
        for (var j = scopes.length - 1; j >= 0; --j) {
          if (prefix in scopes[j].lookup) {
            return scopes[j].lookup[prefix];
          }
        }
        return undefined;
      }
      function getName(name: string, resolveDefaultNs: boolean): any {
        var j = name.indexOf(':');
        if (j >= 0) {
          var prefix = name.substring(0,j);
          var namespace = lookupNs(prefix);
          if (namespace === undefined) {
            throw "Unknown namespace: " + prefix;
          }
          var localName = name.substring(j + 1);
          return {
            name: namespace + '::' + localName,
            localName: localName,
            prefix: prefix,
            namespace: namespace,
          };
        } else if (resolveDefaultNs) {
          return {
            name: name,
            localName: name,
            prefix: '',
            namespace: lookupDefaultNs()
          };
        } else {
          return {
            name:name,
            localName: name,
            prefix: '',
            namespace: ''
          };
        }
      }

      function parseContent(s, start) {
        var pos = start, name, attributes = [];
        function skipWs() {
          while (pos < s.length && isWhitespace(s, pos)) {
            ++pos;
          }
        }
        while (pos < s.length && !isWhitespace(s, pos) && s[pos] !== ">" && s[pos] !== "/") {
          ++pos;
        }
        name = s.substring(start, pos);
        skipWs();
        while (pos < s.length && s[pos] !== ">" &&
          s[pos] !== "/" && s[pos] !== "?") {
          skipWs();
          var attrName = "", attrValue = "";
          while (pos < s.length && !isWhitespace(s, pos) && s[pos] !== "=") {
            attrName += s[pos];
            ++pos;
          }
          skipWs();
          if (s[pos] !== "=") throw "'=' expected";
          ++pos;
          skipWs();
          var attrEndChar = s[pos];
          if (attrEndChar !== "\"" && attrEndChar !== "\'" ) throw "Quote expected";
          var attrEndIndex = s.indexOf(attrEndChar, ++pos);
          if (attrEndIndex < 0) throw "Unexpected EOF[6]";
          attrValue = s.substring(pos, attrEndIndex);
          attributes.push({name: attrName, value: resolveEntities(attrValue)});
          pos = attrEndIndex + 1;
          skipWs();
        }
        return {name: name, attributes: attributes, parsed: pos - start};
      }

      function parseProcessingInstruction(s, start) {
        var pos = start, name, value;
        function skipWs() {
          while (pos < s.length && isWhitespace(s, pos)) {
            ++pos;
          }
        }
        while (pos < s.length && !isWhitespace(s, pos) && s[pos] !== ">" && s[pos] !== "/") {
          ++pos;
        }
        name = s.substring(start, pos);
        skipWs();
        var attrStart = pos;
        while (pos < s.length && (s[pos] !== "?" || s[pos + 1] != '>')) {
          ++pos;
        }
        value = s.substring(attrStart, pos);
        return {name: name, value: value, parsed: pos - start};
      }

      while (i < s.length) {
        var ch = s[i];
        var j = i;
        if (ch === "<") {
          ++j;
          var ch2 = s[j], q, name;
          switch (ch2) {
            case "/":
              ++j;
              q = s.indexOf(">", j); if(q < 0) { throw "Unexpected EOF[1]"; }
              name = getName(s.substring(j,q), true);
              sink.endElement(name);
              scopes.pop();
              j = q + 1;
              break;
            case "?":
              ++j;
              var pi = parseProcessingInstruction(s, j);
              if (s.substring(j + pi.parsed, j + pi.parsed + 2) != "?>") {
                throw "Unexpected EOF[2]";
              }
              sink.pi(pi.name, pi.value);
              j += pi.parsed + 2;
              break;
            case "!":
              if (s.substring(j + 1, j + 3) === "--") {
                q = s.indexOf("-->", j + 3); if(q < 0) { throw "Unexpected EOF[3]"; }
                sink.comment(s.substring(j + 3, q));
                j = q + 3;
              } else if (s.substring(j + 1, j + 8) === "[CDATA[") {
                q = s.indexOf("]]>", j + 8); if(q < 0) { throw "Unexpected EOF[4]"; }
                sink.cdata(s.substring(j + 8, q));
                j = q + 3;
              } else if (s.substring(j + 1, j + 8) === "DOCTYPE") {
                var q2 = s.indexOf("[", j + 8), complexDoctype = false;
                q = s.indexOf(">", j + 8); if(q < 0) { throw "Unexpected EOF[5]"; }
                if (q2 > 0 && q > q2) {
                  q = s.indexOf("]>", j + 8); if(q < 0) { throw "Unexpected EOF[7]"; }
                  complexDoctype = true;
                }
                var doctypeContent = s.substring(j + 8, q + (complexDoctype ? 1 : 0));
                sink.doctype(doctypeContent);
                // XXX pull entities ?
                j = q + (complexDoctype ? 2 : 1);
              } else {
                throw "Unknown !tag";
              }
              break;
            default:
              var content = parseContent(s, j);
              var isClosed = false;
              if (s.substring(j + content.parsed, j + content.parsed + 2) === "/>") {
                isClosed = true;
              } else if (s.substring(j + content.parsed, j + content.parsed + 1) !== ">") {
                throw "Unexpected EOF[2]";
              }
              var scope: any = {namespaces:[], lookup: Object.create(null)};
              var contentAttributes = content.attributes;
              for (q = 0; q < contentAttributes.length; ++q) {
                var attribute = contentAttributes[q];
                var attributeName = attribute.name;
                if (attributeName.substring(0, 6) === "xmlns:") {
                  var prefix = attributeName.substring(6);
                  var uri = attribute.value;
                  if (lookupNs(prefix) !== uri) {
                    scope.lookup[prefix] = trimWhitespaces(uri);
                    scope.namespaces.push({uri: uri, prefix: prefix});
                  }
                  delete contentAttributes[q];
                } else if (attributeName === "xmlns") {
                  var uri = attribute.value;
                  if (lookupDefaultNs() !== uri) {
                    scope["xmlns"] = trimWhitespaces(uri);
                    scope.namespaces.push({uri: uri, prefix: ''});
                  }
                  delete contentAttributes[q];
                } else if (attributeName.substring(0, 4) === "xml:") {
                  var xmlAttrName = attributeName.substring(4);
                  if (xmlAttrName !== 'space' &&
                      xmlAttrName !== 'lang' &&
                      xmlAttrName !== 'base' &&
                      xmlAttrName !== 'id')
                  {
                    throw "Invalid xml attribute: " + attributeName;
                  }
                  scope[xmlAttrName] = trimWhitespaces(attribute.value);
                } else if (attributeName.substring(0, 3) === "xml") {
                  throw "Invalid xml attribute";
                } else {
                  // skip ordinary attributes until all xmlns have been handled
                }
              }
              // build list of all namespaces including ancestors'
              var inScopeNamespaces: any[] = [];
              scope.namespaces.forEach(function (ns) {
                if (!ns.prefix || scope.lookup[ns.prefix] === ns.uri) {
                  inScopeNamespaces.push(ns);
                }
              });
              scopes[scopes.length - 1].inScopes.forEach(function (ns) {
                if ((ns.prefix && !(ns.prefix in scope.lookup)) ||
                    (!ns.prefix && !('xmlns' in scope))) {
                  inScopeNamespaces.push(ns);
                }
              });
              scope.inScopes = inScopeNamespaces;

              scopes.push(scope);
              var attributes = [];
              for (q = 0; q < contentAttributes.length; ++q) {
                attribute = contentAttributes[q];
                if (attribute) {
                  attributes.push({name: getName(attribute.name, false), value: attribute.value});
                }
              }
              sink.beginElement(getName(content.name, true), attributes, inScopeNamespaces, isClosed);
              j += content.parsed + (isClosed ? 2 : 1);
              if (isClosed) scopes.pop();
              break;
          }
        } else {
          do {
          } while(j++ < s.length && s[j] !== "<");
          var text = s.substring(i, j);
          sink.text(resolveEntities(text), isWhitespacePreserved());
        }
        i = j;
      }
    }
    // end of parser

    this.parseFromString = function(s, mimeType?) {
      var currentElement = createXML(ASXMLKind.Element, '', '', '');  // placeholder
      var elementsStack = [];
      parseXml(s, {
        beginElement: function(name, attrs, namespaces, isEmpty) {
          var parent = currentElement;
          elementsStack.push(parent);
          currentElement = createNode(ASXMLKind.Element, name.namespace, name.localName, name.prefix);
          for (var i = 0; i < attrs.length; ++i) {
            var rawAttr = attrs[i];
            var attr = createNode(ASXMLKind.Attribute, rawAttr.name.namespace, rawAttr.name.localName, rawAttr.name.prefix);
            attr._value = rawAttr.value;
            attr._parent = currentElement;
            currentElement._attributes.push(attr);
          }
          for (var i = 0; i < namespaces.length; ++i) {
            var rawNs = namespaces[i];
            var ns = new AS.ASNamespace(rawNs.prefix, rawNs.uri);
            currentElement._inScopeNamespaces.push(ns);
          }
          parent.insert(parent.length(), currentElement);
          if (isEmpty) {
            currentElement = elementsStack.pop();
          }
        },
        endElement: function(name) {
          currentElement = elementsStack.pop();
        },
        text: function(text, isWhitespacePreserve) {
          if (ASXML.ignoreWhitespace) {
            text = trimWhitespaces(text);
          }
          // TODO: do an in-depth analysis of what isWhitespacePreserve is about.
          if (text.length === 0 || isWhitespacePreserve && ASXML.ignoreWhitespace) {
            return;
          }
          var node = createNode(ASXMLKind.Text, "", "");
          node._value = text;
          currentElement.insert(currentElement.length(), node);
        },
        cdata: function(text) {
          var node = createNode(ASXMLKind.Text, "", "");
          node._value = text;
          currentElement.insert(currentElement.length(), node);
        },
        comment: function(text) {
          if (ASXML.ignoreComments) {
            return;
          }
          var node = createNode(ASXMLKind.Comment, "", "");
          node._value = text;
          currentElement.insert(currentElement.length(), node);
        },
        pi: function(name, value) {
          if (ASXML.ignoreProcessingInstructions) {
            return;
          }
          var node = createNode(ASXMLKind.ProcessingInstruction, "", name);
          node._value = value;
          currentElement.insert(currentElement.length(), node);
        },
        doctype: function(text) { }
      });
      return currentElement;
    };

    function createNode(kind: ASXMLKind, uri, name, prefix?) {
      return createXML(kind, uri, name, prefix);
    }
  }

  var xmlParser = new XMLParser();

  export class ASNamespace extends ASObject implements XMLType {
    public static staticNatives: any [] = null;
    public static instanceNatives: any [] = null;
    public static instanceConstructor: any = ASNamespace;
    static classInitializer: any = function() {
      defineNonEnumerableProperty(this, '$Bglength', 2);
      var proto: any = ASNamespace.prototype;
      defineNonEnumerableProperty(proto, '$BgtoString', proto.toString);
    }

    private _ns: Namespace;

    /**
     * 13.2.1 The Namespace Constructor Called as a Function
     *
     * Namespace ()
     * Namespace (uriValue)
     * Namespace (prefixValue, uriValue)
     */
    public static callableConstructor: any = function (a?: any, b?: any): ASNamespace {
      // 1. If (prefixValue is not specified and Type(uriValue) is Object and
      // uriValue.[[Class]] == "Namespace")
      if (arguments.length === 1 && isObject(a) && a instanceof ASNamespace) {
        // a. Return uriValue
        return a;
      }
      // 2. Create and return a new Namespace object exactly as if the Namespace constructor had
      // been called with the same arguments (section 13.2.2).
      switch (arguments.length) {
        case 0:
          return new AS.ASNamespace();
        case 1:
          return new AS.ASNamespace(a);
        default:
          return new AS.ASNamespace(a, b);
      }
    };

    /**
     * 13.2.2 The Namespace Constructor
     *
     * Namespace ()
     * Namespace (uriValue)
     * Namespace (prefixValue, uriValue)
     */
    constructor(a?: any, b?: any) {
      false && super();
      // 1. Create a new Namespace object n
      var uri: string = "";
      var prefix: string = "";
      // 2. If prefixValue is not specified and uriValue is not specified
      if (arguments.length === 0) {
        // a. Let n.prefix be the empty string
        // b. Let n.uri be the empty string
      }
      // 3. Else if prefixValue is not specified
      else if (arguments.length === 1) {
        var uriValue = a;
        // a. If Type(uriValue) is Object and uriValue.[[Class]] == "Namespace"
        if (isObject(uriValue) && uriValue instanceof ASNamespace) {
          var uriValueAsNamespace: ASNamespace = uriValue;
          // i. Let n.prefix = uriValue.prefix
          prefix = uriValueAsNamespace.prefix;
          // ii. Let n.uri = uriValue.uri
          uri = uriValueAsNamespace.uri;
        }
        // b. Else if Type(uriValue) is Object and uriValue.[[Class]] == "QName" and uriValue.uri
        // is not null
        else if (isObject(uriValue) && uriValue instanceof ASQName && (<ASQName>uriValue).uri !== null) {
          // i. Let n.uri = uriValue.uri
          uri = uriValue.uri;
          // NOTE implementations that preserve prefixes in qualified names may also set n.prefix =
          // uriValue.[[Prefix]]
        }
        // c. Else
        else {
          // i. Let n.uri = ToString(uriValue)
          uri = toString(uriValue);
          // ii. If (n.uri is the empty string), let n.prefix be the empty string
          if (uri === "") {
            prefix = "";
          }
          // iii. Else n.prefix = undefined
          else {
            prefix = undefined;
          }
        }
      }
      // 4. Else
      else {
        var prefixValue = a;
        var uriValue = b;
        // a. If Type(uriValue) is Object and uriValue.[[Class]] == "QName" and uriValue.uri is not
        // null
        if (isObject(uriValue) && uriValue instanceof ASQName && (<ASQName>uriValue).uri !== null) {
          // i. Let n.uri = uriValue.uri
          uri = uriValue.uri
        }
        // b. Else
        else {
          // i. Let n.uri = ToString(uriValue)
          uri = toString(uriValue);
        }
        // c. If n.uri is the empty string
        if (uri === "") {
          // i. If prefixValue is undefined or ToString(prefixValue) is the empty string
          if (prefixValue === undefined || toString(prefixValue) === "") {
            // 1. Let n.prefix be the empty string
            prefix = "";
          }
          else {
            // ii. Else throw a TypeError exception
            Runtime.throwError('TypeError', Errors.XMLNamespaceWithPrefixAndNoURI, prefixValue);
          }
        }
        // d. Else if prefixValue is undefined, let n.prefix = undefined
        else if (prefixValue === undefined) {
          prefix = undefined;
        }
        // e. Else if isXMLName(prefixValue) == false
        else if (isXMLName(prefixValue) === false) {
          // i. Let n.prefix = undefined
          prefix = undefined;
        }
        // f. Else let n.prefix = ToString(prefixValue)
        else {
          prefix = toString(prefixValue);
        }
      }
      // 5. Return n
      this._ns = Namespace.createNamespace(uri, prefix);
    }

    // E4X 11.5.1 The Abstract Equality Comparison Algorithm, step 3.c.
    equals(other: any): boolean {
      return other instanceof ASNamespace && (<ASNamespace>other)._ns.uri === this._ns.uri ||
             typeof other === 'string' && this._ns.uri === other;
    }

    get prefix(): any {
      return this._ns.prefix;
    }

    get uri(): string {
      return this._ns.uri;
    }

    toString() {
      if (this === ASNamespace.prototype) {
        return '';
      }
      return this._ns.uri;
    }

    valueOf() {
      if (this === ASNamespace.prototype) {
        return '';
      }
      return this._ns.uri;
    }

  }

  enum ASQNameFlags {
    ATTR_NAME = 1,
    ELEM_NAME = 2,
    ANY_NAME = 4,
    ANY_NAMESPACE = 8
  }

  export class ASQName extends ASNative implements XMLType {
    static classInitializer: any = function() {
      defineNonEnumerableProperty(this, '$Bglength', 2);
      var proto: any = ASQName.prototype;
      defineNonEnumerableProperty(proto, '$BgtoString', proto.ecmaToString);
    }

    /**
     * 13.3.1 The QName Constructor Called as a Function
     *
     * QName ( )
     * QName ( Name )
     * QName ( Namespace , Name )
     */
    public static callableConstructor: any = function (a?: any, b?: any): ASQName {
      // 1. If Namespace is not specified and Type(Name) is Object and Name.[[Class]] == “QName”
      if (arguments.length === 1 && isObject(a) && a instanceof ASQName) {
        // a. Return Name
        return  a;
      }
      // 2. Create and return a new QName object exactly as if the QName constructor had been
      // called with the same arguments (section 13.3.2).
      switch (arguments.length) {
        case 0:
          return new AS.ASQName();
        case 1:
          return new AS.ASQName(a);
        default:
          return new AS.ASQName(a, b);
      }
    };

    name: Multiname;

    static fromMultiname(mn: Multiname) {
      var result: ASQName = Object.create(ASQName.prototype);
      result.name = mn;
      return result;
      return result;
    }

    /**
     * 13.3.2 The QName Constructor
     *
     * new QName ()
     * new QName (Name)
     * new QName (Namespace, Name)
     */
    constructor(nameOrNS_?: any, name_?: any, isAttribute?: boolean) {
      false && super();

      var name;
      var namespace;

      if (arguments.length === 0) {
        name = "";
      } else if (arguments.length === 1) {
        name = nameOrNS_;
      } else { // if (arguments.length === 2) {
        namespace = nameOrNS_;
        name = name_;
      }

      // 1. If (Type(Name) is Object and Name.[[Class]] == "QName")
      if (isObject(name) && name instanceof ASQName) {
        // a. If (Namespace is not specified), return a copy of Name
        if (arguments.length < 2) {
          return name;
        }
        // b. Else let Name = Name.localName
        else {
          name = <ASQName>name.localName;
        }
      }
      // 2. If (Name is undefined or not specified)
      if (name === undefined || arguments.length === 0) {
        // a. Let Name = ""
        name = "";
      }
      // 3. Else let Name = ToString(Name)
      else {
        name = toString(name);
      }
      // 4. If (Namespace is undefined or not specified)
      if (namespace === undefined || arguments.length < 2) {
        // a. If Name = "*"
        if (name === "*") {
          // i. Let Namespace = null
          namespace = null;
        }
        // b. Else
        else {
          // i. Let Namespace = GetDefaultNamespace()
          namespace = getDefaultNamespace();
        }
      }
      // 5. Let q be a new QName with q.localName = Name
      var localName = name;
      var uri;
      // 6. If Namespace == null
      if (namespace === null) {
        // a. Let q.uri = null
        // NOTE implementations that preserve prefixes in qualified names may also set q.[[Prefix]]
        // to undefined
        uri = null;
      }
      // 7. Else
      else {
        // a. Let Namespace be a new Namespace created as if by calling the constructor new
        // Namespace(Namespace)
        namespace = namespace instanceof ASNamespace ? namespace : new AS.ASNamespace(namespace);
        // b. Let q.uri = Namespace.uri
        uri = namespace.uri;
          // NOTE implementations that preserve prefixes in qualified names may also set
          // q.[[Prefix]] to Namespace.prefix
      }
      // 8. Return q
      var flags = isAttribute ? ASQNameFlags.ATTR_NAME : ASQNameFlags.ELEM_NAME;
      if (name === '*') {
        flags |= ASQNameFlags.ANY_NAME;
      }
      if (namespace === null) {
        flags |= ASQNameFlags.ANY_NAMESPACE;
      }
      this.name = new Multiname([namespace ? namespace._ns : null], localName, flags);
    }

    // E4X 11.5.1 The Abstract Equality Comparison Algorithm, step 3.b.
    equals(other: any): boolean {
      return other instanceof ASQName &&
             (<ASQName>other).uri === this.uri && (<ASQName>other).name.name === this.name.name ||
             typeof other === 'string' && this.toString() === other;
    }

    get localName(): string {
      return this.name.name;
    }

    get uri(): string {
      return this.name.namespaces[0] ? this.name.namespaces[0].uri : null;
    }

    setUri(uri: string) {
      if (!this.name.namespaces[0]) {
        this.name.namespaces.push(Namespace.createNamespace(uri));
      }
      this.name.namespaces[0].uri = uri;
    }

    ecmaToString (): string {
      if (<any>this === ASQName.dynamicPrototype) {
        return "";
      }
      if (!(this instanceof AS.ASQName)) {
        throwError('TypeError', Errors.InvokeOnIncompatibleObjectError, "QName.prototype.toString");
      }
      return this.toString();
    }

    toString() {
      var uri = this.uri;
      if (uri === "") {
        return this.name.name;
      }
      if (uri === null) {
        return "*::" + this.name.name;
      }
      var cc = uri.charCodeAt(uri.length - 1);
      // strip the version mark, if there is one
      var base_uri = uri;
      if(cc >= 0xE000 && cc <= 0xF8FF) {
        base_uri = uri.substr(0, uri.length - 1);
      }
      if (base_uri === "") {
        return this.name.name;
      }
      return base_uri + "::" + this.name.name;
    }

    valueOf() {
      return this;
    }

    /**
     * 13.3.5.3 [[Prefix]]
     * The [[Prefix]] property is an optional internal property that is not directly visible to
     * users. It may be used by implementations that preserve prefixes in qualified names. The
     * value of the [[Prefix]] property is a value of type string or undefined. If the [[Prefix]]
     * property is undefined, the prefix associated with this QName is unknown.
     */
    get prefix(): string {
      return this.name.namespaces[0] ? this.name.namespaces[0].prefix : null;
    }

    /**
     * 13.3.5.4 [[GetNamespace]] ( [ InScopeNamespaces ] )
     *
     * The [[GetNamespace]] method is an internal method that returns a Namespace object with a URI
     * matching the URI of this QName. InScopeNamespaces is an optional parameter. If
     * InScopeNamespaces is unspecified, it is set to the empty set. If one or more Namespaces
     * exists in InScopeNamespaces with a URI matching the URI of this QName, one of the matching
     * Namespaces will be returned. If no such namespace exists in InScopeNamespaces,
     * [[GetNamespace]] creates and returns a new Namespace with a URI matching that of this QName.
     * For implementations that preserve prefixes in QNames, [[GetNamespace]] may return a
     * Namespace that also has a matching prefix. The input argument InScopeNamespaces is a set of
     * Namespace objects.
     */
    getNamespace(inScopeNamespaces?: ASNamespace []) {
      if (this.uri === null) {
        throw "TypeError in QName.prototype.getNamespace()";
      }
      if (!inScopeNamespaces) {
        inScopeNamespaces = [];
      }
      var ns: ASNamespace;
      for (var i = 0; i < inScopeNamespaces.length; i++) {
        if (this.uri === inScopeNamespaces[i].uri) {
          ns = inScopeNamespaces[i];
        }
      }
      if (!ns) {
        ns = new AS.ASNamespace(this.prefix, this.uri);
      }
      return ns;
    }

    get flags() {
      return this.name.flags;
    }
  }

  enum ASXML_FLAGS {
    FLAG_IGNORE_COMMENTS                = 0x01,
    FLAG_IGNORE_PROCESSING_INSTRUCTIONS = 0x02,
    FLAG_IGNORE_WHITESPACE              = 0x04,
    FLAG_PRETTY_PRINTING                = 0x08,
    ALL = FLAG_IGNORE_COMMENTS | FLAG_IGNORE_PROCESSING_INSTRUCTIONS | FLAG_IGNORE_WHITESPACE | FLAG_PRETTY_PRINTING
  }

  export enum ASXMLKind {
    Unknown = 0,
    Element = 1,
    Attribute = 2,
    Text = 3,
    Comment = 4,
    ProcessingInstruction = 5
  }

  var ASXMLKindNames = [null, 'element', 'attribute', 'text', 'comment', 'processing-instruction'];

  export interface XMLType {
    equals(other: any): boolean;
  }

  export class ASXML extends ASNative implements XMLType {
    public static instanceConstructor: any = ASXML;
    static classInitializer: any = function() {
      defineNonEnumerableProperty(this, '$Bglength', 1);

      var proto: any = ASXML.prototype;
      defineNonEnumerableProperty(proto, 'asDeleteProperty', proto._asDeleteProperty);
      defineNonEnumerableProperty(proto, '$BgvalueOf', Object.prototype['$BgvalueOf']);
      defineNonEnumerableProperty(proto, '$BghasOwnProperty', proto.native_hasOwnProperty);
      defineNonEnumerableProperty(proto, '$BgpropertyIsEnumerable',
                                  proto.native_propertyIsEnumerable);

      createPublicAliases(ASXML, [
        'settings',
        'setSettings',
        'defaultSettings'
      ]);

      createPublicAliases(proto, [
        'toString',
        'addNamespace',
        'appendChild',
        'attribute',
        'attributes',
        'child',
        'childIndex',
        'children',
        'comments',
        'contains',
        'copy',
        'descendants',
        'elements',
        'hasComplexContent',
        'hasSimpleContent',
        'inScopeNamespaces',
        'insertChildAfter',
        'insertChildBefore',
        'length',
        'localName',
        'name',
        'namespace',
        'namespaceDeclarations',
        'nodeKind',
        'normalize',
        'parent',
        'processingInstructions',
        'prependChild',
        'removeNamespace',
        'replace',
        'setChildren',
        'setLocalName',
        'setName',
        'setNamespace',
        'text',
        'toXMLString',
        'toJSON'
      ]);
    };

    public static callableConstructor: any = function (value?: any): ASXML {
      // 13.5.1 The XMLList Constructor Called as a Function
      if (isNullOrUndefined(value)) {
        value = '';
      }
      return toXML(value);
    };


    static native_settings():Object {
      return {
        $BgignoreComments: ASXML.ignoreComments,
        $BgignoreProcessingInstructions: ASXML.ignoreProcessingInstructions,
        $BgignoreWhitespace: ASXML.ignoreWhitespace,
        $BgprettyPrinting: ASXML.prettyPrinting,
        $BgprettyIndent: ASXML.prettyIndent
      };
    }

    static native_setSettings(o:any):void {
      if (isNullOrUndefined(o)) {
        ASXML.ignoreComments = true;
        ASXML.ignoreProcessingInstructions = true;
        ASXML.ignoreWhitespace = true;
        ASXML.prettyPrinting = true;
        ASXML.prettyIndent = 2;
        return;
      }

      if (typeof o.$BgignoreComments === 'boolean') {
        ASXML.ignoreComments = o.$BgignoreComments;
      }
      if (typeof o.$BgignoreProcessingInstructions === 'boolean') {
        ASXML.ignoreProcessingInstructions = o.$BgignoreProcessingInstructions;
      }
      if (typeof o.$BgignoreWhitespace === 'boolean') {
        ASXML.ignoreWhitespace = o.$BgignoreWhitespace;
      }
      if (o.$BgprettyPrinting === 'boolean') {
        ASXML.prettyPrinting = o.$BgprettyPrinting;
      }
      if (o.$BgprettyIndent === 'number') {
        ASXML.prettyIndent = o.$BgprettyIndent;
      }
    }

    static native_defaultSettings():Object {
      return {
        $BgignoreComments: true,
        $BgignoreProcessingInstructions: true,
        $BgignoreWhitespace: true,
        $BgprettyPrinting: true,
        $BgprettyIndent: 2
      };
    }

    public static defaultNamespace = '';
    private static _flags: ASXML_FLAGS = ASXML_FLAGS.ALL;
    private static _prettyIndent = 2;
    _attributes: ASXML[];
    _inScopeNamespaces: ASNamespace[];

    // These properties are public so ASXMLList can access them.
    _kind: ASXMLKind;
    _name: ASQName;
    _value: any;
    _parent: ASXML;
    _children: ASXML[];

    constructor (value?: any) {
      false && super();

      this._parent = null;

      if (isNullOrUndefined(value)) {
        value = "";
      }
      if (typeof value === 'string' && value.length === 0) {
        this._kind = ASXMLKind.Text;
        this._value = '';
        return;
      }
      var x = toXML(value);
      if (isXMLType(value)) {
        x = x._deepCopy();
      }
      return x;
    }

    valueOf() {
      return this;
    }

    // E4X 11.5.1 The Abstract Equality Comparison Algorithm, steps 1-4.
    equals(other: any): boolean {
      // Steps 1,2.
      if (other instanceof ASXMLList) {
        return other.equals(this);
      }
      // Step 3.
      if (other instanceof ASXML) {
        // Step 3.a.i.
        var otherXML = <ASXML>other;
        if ((this._kind === ASXMLKind.Text || this._kind === ASXMLKind.Attribute) &&
            otherXML.hasSimpleContent() ||
            (otherXML._kind === ASXMLKind.Text || otherXML._kind === ASXMLKind.Attribute) &&
            this.hasSimpleContent()) {
          return this.toString() === other.toString();
        }
        // Step 3.a.ii.
        return this._deepEquals(other);
        // The rest of step 3 is implemented in {Namespace,QName}.equals and non-E4X parts of the
        // engine.
      }
      // Step 4.
      return this.hasSimpleContent() && this.toString() === asCoerceString(other);
      // The remaining steps are implemented by other means in the interpreter/compiler.
    }

    init(kind: number, uri, name, prefix) {
      var namespace = uri || prefix ? new AS.ASNamespace(prefix, uri) : undefined;
      var isAttribute = kind === ASXMLKind.Attribute;
      this._name = new AS.ASQName(namespace, name, isAttribute);
      this._kind = kind;    // E4X [[Class]]
      this._parent = null;
      switch (<ASXMLKind> kind) {
        case ASXMLKind.Element:
          this._inScopeNamespaces = [];
          this._attributes = [];
          this._children = [];  // child nodes go here
          break;
        case ASXMLKind.Comment:
        case ASXMLKind.ProcessingInstruction:
        case ASXMLKind.Attribute:
        case ASXMLKind.Text:
          this._value = '';
          break;
        default:
          break;
      }
      return this;
    }

    // 9.1.1.9 [[Equals]] (V)
    _deepEquals(V: XMLType) {
      // Step 1.
      if (!(V instanceof ASXML)) {
        return false;
      }
      var other = <ASXML>V;
      // Step 2.
      if (this._kind !== other._kind) {
        return false;
      }
      // Steps 3-4.
      if (!!this._name !== !!other._name || (this._name && !this._name.equals(other._name))) {
        return false;
      }
      // Not in the spec, but a substantial optimization.
      if (this._kind !== ASXMLKind.Element) {
        // Step 7.
        // This only affects non-Element nodes, so moved up here.
        if (this._value !== other._value) {
          return false;
        }
        return true;
      }
      // Step 5.
      var attributes = this._attributes;
      var otherAttributes = other._attributes;
      if (attributes.length !== otherAttributes.length) {
        return false;
      }
      // Step 6.
      var children = this._children;
      var otherChildren = other._children;
      if (children.length !== otherChildren.length) {
        return false;
      }
      // Step 8.
      attribOuter: for (var i = 0; i < attributes.length; i++) {
        var attribute = attributes[i];
        for (var j = 0; j < otherAttributes.length; j++) {
          var otherAttribute = otherAttributes[j];
          if (otherAttribute._name.equals(attribute._name) &&
              otherAttribute._value === attribute._value) {
            continue attribOuter;
          }
        }
        return false;
      }
      // Step 9.
      for (var i = 0; i < children.length; i++) {
        if (!children[i].equals(otherChildren[i])) {
          return false;
        }
      }
      // Step 10.
      return true;
    }

    // 9.1.1.7 [[DeepCopy]] ( )
    _deepCopy(): ASXML {
      var kind: ASXMLKind = this._kind;
      var clone = new AS.ASXML();
      clone._kind = kind;
      clone._name = this._name;
      switch (kind) {
        case ASXMLKind.Element:
          clone._inScopeNamespaces = [];
          if (this._inScopeNamespaces.length > 0) {
            this._inScopeNamespaces.forEach(function (ns) {
              clone._inScopeNamespaces.push(new AS.ASNamespace(ns.prefix, ns.uri));
            });
          }
          clone._attributes = this._attributes.map(function (attr) {
            attr = attr._deepCopy();
            attr._parent = clone;
            return attr;
          });
          clone._children = this._children.map(function (child) {
            child = child._deepCopy();
            child._parent = clone;
            return child;
          });
          break;
        case ASXMLKind.Comment:
        case ASXMLKind.ProcessingInstruction:
        case ASXMLKind.Attribute:
        case ASXMLKind.Text:
          clone._value = this._value;
          break;
        default:
          break;
      }
      return clone;
    }

    // 9.1.1.10 [[ResolveValue]] ( )
    resolveValue() {
      return this;
    }

    _addInScopeNamespaces(ns) {
      if (this._inScopeNamespaces.some(function (ins) { return ins.uri === ns.uri && ins.prefix === ns.prefix; })) {
        return;
      }
      this._inScopeNamespaces.push(ns);
    }

    static get ignoreComments(): boolean {
      return !!(ASXML._flags & ASXML_FLAGS.FLAG_IGNORE_COMMENTS);
    }
    static set ignoreComments(newIgnore: boolean) {
      newIgnore = !!newIgnore;
      if (newIgnore) {
        ASXML._flags |= ASXML_FLAGS.FLAG_IGNORE_COMMENTS;
      } else {
        ASXML._flags &= ~ASXML_FLAGS.FLAG_IGNORE_COMMENTS;
      }
    }
    static get ignoreProcessingInstructions(): boolean {
      return !!(ASXML._flags & ASXML_FLAGS.FLAG_IGNORE_PROCESSING_INSTRUCTIONS);
    }
    static set ignoreProcessingInstructions(newIgnore: boolean) {
      newIgnore = !!newIgnore;
      if (newIgnore) {
        ASXML._flags |= ASXML_FLAGS.FLAG_IGNORE_PROCESSING_INSTRUCTIONS;
      } else {
        ASXML._flags &= ~ASXML_FLAGS.FLAG_IGNORE_PROCESSING_INSTRUCTIONS;
      }
    }
    static get ignoreWhitespace(): boolean {
      return !!(ASXML._flags & ASXML_FLAGS.FLAG_IGNORE_WHITESPACE);
    }
    static set ignoreWhitespace(newIgnore: boolean) {
      newIgnore = !!newIgnore;
      if (newIgnore) {
        ASXML._flags |= ASXML_FLAGS.FLAG_IGNORE_WHITESPACE;
      } else {
        ASXML._flags &= ~ASXML_FLAGS.FLAG_IGNORE_WHITESPACE;
      }
    }
    static get prettyPrinting(): boolean {
      return !!(ASXML._flags & ASXML_FLAGS.FLAG_PRETTY_PRINTING);
    }
    static set prettyPrinting(newPretty: boolean) {
      newPretty = !!newPretty;
      if (newPretty) {
        ASXML._flags |= ASXML_FLAGS.FLAG_PRETTY_PRINTING;
      } else {
        ASXML._flags &= ~ASXML_FLAGS.FLAG_PRETTY_PRINTING;
      }
    }
    static get prettyIndent(): number /*int*/ {
      return ASXML._prettyIndent;
    }
    static set prettyIndent(newIndent: number /*int*/) {
      newIndent = newIndent | 0;
      ASXML._prettyIndent = newIndent;
    }
    toString(): string {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return '';
      }
      if (this.hasComplexContent()) {
        return this.toXMLString();
      }
      return toString(this);
    }
    // 13.4.4.14 XML.prototype.hasOwnProperty ( P )
    native_hasOwnProperty(P: string): boolean {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return ASObject.prototype.native_hasOwnProperty.call(this, P);
      }
      var mn = toXMLName(P);
      var isAttribute = !!(mn.flags & ASQNameFlags.ATTR_NAME);
      if (this.hasProperty(mn, isAttribute, false)) {
        return true;
      }
      return _asHasOwnProperty.call(this, String(P));
    }
    // 13.4.4.30 XML.prototype.propertyIsEnumerable ( P )
    native_propertyIsEnumerable(P: any = undefined): boolean {
      return String(P) === "0";
    }
    addNamespace(ns: any): ASXML {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.2 XML.prototype.addNamespace ( namespace )
      this._addInScopeNamespaces(new AS.ASNamespace(ns));
      return this;
    }
    appendChild(child: any): ASXML {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // TODO review
      if (child._parent) {
        var index = child._parent._children.indexOf(child);
        release || assert(index >= 0);
        child._parent._children.splice(index, 1);
      }
      this._children.push(child);
      child._parent = this;
      return this;
    }
    attribute(arg: any): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      return this.getProperty(arg, true);
    }
    attributes(): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      var list = AS.ASXMLList.createList(this, this._name);
      Array.prototype.push.apply(list._children, this._attributes);
      return list;
    }

    // 13.4.4.6
    child(propertyName: any /* string|number */): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // Step 1.
      if (isIndex(propertyName)) {
        var list = AS.ASXMLList.createList();
        if (this._children && propertyName < this._children.length) {
          list.append(this._children[propertyName | 0]);
        }
        return list;
      }
      // Steps 2-3.
      return this.getProperty(propertyName, isQNameAttribute(propertyName));
    }
    childIndex(): number /*int*/ {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.7 XML.prototype.childIndex ( )
      if (!this._parent || this._kind === ASXMLKind.Attribute) {
        return -1;
      }
      return this._parent._children.indexOf(this);
    }
    children(): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      var xl = AS.ASXMLList.createList(this, this._name);
      Array.prototype.push.apply(xl._children, this._children);
      return xl;
    }
    comments() {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.9 XML.prototype.comments ( )
      var self: ASXML = this;
      var xl = AS.ASXMLList.createList(this, this._name);
      self._children && self._children.forEach(function (v, i) {
        if (v._kind === ASXMLKind.Comment) {
          xl.append(v);
        }
      });
      return xl;
    }
    contains(value: any): boolean {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.10 XML.prototype.contains ( value )
      return this === value;
    }
    copy(): ASXML {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      return this._deepCopy();
    }
    // 9.1.1.8 [[Descendants]] (P)
    descendants(name_: any = "*"): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      var xl = AS.ASXMLList.createList(this, this._name);
      var name = toXMLName(name_);
      return this.descendantsInto(name, xl);
    }
    elements(name: any = "*"): ASXMLList {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.13 XML.prototype.elements ( [ name ] )
      return this.getProperty(name, false);
    }
    hasComplexContent(): boolean {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.15 XML.prototype.hasComplexContent( )
      if (this._kind === ASXMLKind.Attribute ||
          this._kind === ASXMLKind.Comment ||
          this._kind === ASXMLKind.ProcessingInstruction ||
          this._kind === ASXMLKind.Text) {
        return false;
      }
      return this._children.some(function (child) {
        return child._kind === ASXMLKind.Element;
      });
    }
    hasSimpleContent(): boolean {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // 13.4.4.16 XML.prototype.hasSimpleContent()
      if (this._kind === ASXMLKind.Comment ||
          this._kind === ASXMLKind.ProcessingInstruction) {
        return false;
      }
      if (this._kind !== ASXMLKind.Element) {
        return true;
      }
      if (!this._children && this._children.length === 0) {
        return true;
      }
      return this._children.every(function (child) {
        return child._kind !== ASXMLKind.Element;
      });
    }

    // 13.4.4.17
    inScopeNamespaces(): ASNamespace[] {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      };
      return this._inScopeNamespacesImpl(false);
    }

    private _inScopeNamespacesImpl(internalUse: boolean) {
      // Step 1.
      var y = this;
      // Step 2.
      var inScopeNS: ASNamespace[] = [];
      var inScopeNSMap = internalUse ? inScopeNS : {};
      // Step 3.
      while (y !== null) {
        // Step 3.a.
        var namespaces = y._inScopeNamespaces;
        for (var i = 0; namespaces && i < namespaces.length; i++) {
          var ns = namespaces[i];
          if (!inScopeNSMap[ns.prefix]) {
            inScopeNSMap[ns.prefix] = ns;
            inScopeNS.push(ns);
          }
        }
        // Step 3.b.
        y = y._parent;
      }
      return inScopeNS;
    }
    insertChildAfter(child1: any, child2: any): any {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      notImplemented("public.XML::insertChildAfter"); return;
    }
    insertChildBefore(child1: any, child2: any): any {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      notImplemented("public.XML::insertChildBefore"); return;
    }
    // XML.[[Length]]
    length(): number {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      if (!this._children) {
        return 0;
      }
      return this._children.length;
    }
    localName(): Object {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      return this._name.localName;
    }
    name(): Object {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      return this._name;
    }

    // 13.4.4.23
    namespace(prefix?: string): any {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // Step 4.a.
      if (arguments.length === 0 && this._kind >= ASXMLKind.Text) {
        return null;
      }
      // Steps 1-3.
      var inScopeNS = this._inScopeNamespacesImpl(true);
      // Step 4.
      if (arguments.length === 0) {
        // Step 4.b.
        return this._name.getNamespace(inScopeNS);
      }
      // Step 5.a.
      prefix = asCoerceString(prefix);
      // Step 5.b-c.
      for (var i = 0; i < inScopeNS.length; i++) {
        var ns = inScopeNS[i];
        if (ns.prefix === prefix) {
          return ns;
        }
      }
      // Step 5.b alternate clause implicit.
    }
    namespaceDeclarations(): any [] {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      notImplemented("public.XML::namespaceDeclarations"); return;
    }
    nodeKind(): string {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      return ASXMLKindNames[this._kind];
    }
    normalize(): ASXML {
      if (!(this instanceof ASXML)) {
        Runtime.throwError('TypeError', Errors.CheckTypeFailedError, this, 'XML');
      }
      // Steps 1-2.
      for (var i = 0; i < this._children.length;) {
        var child = this._children[i];
        // Step 2.a.
        if (child._kind === ASXMLKind.Element) {
          child.normalize();
          i++;
        }
        // Step 2.b.
        else if (child._kind === ASXMLKind.Text) {
          // Step 2.b.i.
          for (i++; i < this._children.length;) {
            var nextChild = this._children[i];
            if (nextChild._kind !== ASXMLKind.Text) {
              break;
            }
            child._value += nextChild._value;
            this.removeByIndex(i);
          }
          // Step 2.b.ii.
          if (child._value.length === 0) {
            this.removeByIndex(i);
          }
          // Step 2.b.iii.
          else {
            i++;
          }
        }
        // Step 2.c.
        else {
          i++;
        }
      }
      return this;
    }

    private removeByIndex(index: number) {
      var child = this._children[index];
      child._parent = null;
      this._children.splice(index, 1);
    }

    parent(): any {
      // Absurdly, and in difference to what the spec says, parent() returns `undefined` for null.
      return this._parent || undefined;
    }
    // 13.4.4.28 XML.prototype.processingInstructions ( [ name ] )
    processingInstructions(name: any = "*"): ASXMLList {
      // Step 1 (implicit).
      // Step 2.
      var localName = toXMLName(name).localName;
      // Step 3.
      var list = AS.ASXMLList.createList(this, this._name);
      list._targetObject = this;
      list._targetProperty = null;
      // Steps 4-5.
      return this.processingInstructionsInto(name, localName, list);
    }
    processingInstructionsInto(name: any, localName: string, list: ASXMLList) {
      // Step 4.
      var children = this._children;
      if (!children) {
        return list;
      }
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child._kind === ASXMLKind.ProcessingInstruction &&
            (name === '*' || child._name.localName === localName)) {
          list._children.push(child);
        }
      }
      // Step 5.
      return list;
    }
    prependChild(value: any): ASXML {

      notImplemented("public.XML::prependChild"); return;
    }
    removeNamespace(ns: any): ASXML {

      notImplemented("public.XML::removeNamespace"); return;
    }
    // 9.1.1.12 [[Replace]] (P, V)
    replace(p: any, v: any): ASXML {
      var s;
      var self: ASXML = this;
      if (self._kind === ASXMLKind.Text ||
          self._kind === ASXMLKind.Comment ||
          self._kind === ASXMLKind.ProcessingInstruction ||
          self._kind === ASXMLKind.Attribute) {
        return self;
      }
      if (v._kind === ASXMLKind.Element) {
        var a = self;
        while (a) {
          if (a === v) {
            throw "Error in XML.prototype.replace()";
          }
          a = a._parent;
        }
      }
      var i = p >>> 0;
      if (String(p) === String(i)) {
        if (i >= self.length()) {
          p = String(self.length());
        }
        if (self._children && self._children[p]) {
          self._children[p]._parent = null;
        }
      } else {
        var toRemove = this.getProperty(p, false);
        if (toRemove.length() === 0) { // nothing to replace
          return self;
        }
        self._children && toRemove._children.forEach(function (v, i) {
          var index = self._children.indexOf(v);
          v._parent = null;
          if (i === 0) {
            p = String(index);
            self._children.splice(index, 1, undefined);
          } else {
            self._children.splice(index, 1);
          }
        });
      }

      if (v._kind === ASXMLKind.Element ||
          v._kind === ASXMLKind.Text ||
          v._kind === ASXMLKind.Comment ||
          v._kind === ASXMLKind.ProcessingInstruction) {
        v._parent = self;
        if (!self._children) {
          self._children = [];
        }
        self._children[p] = v;
      } else {
        s = toString(v);
        var t = createXML();
        t._parent = self;
        t._value = s;
        if (!self._children) {
          self._children = [];
        }
        self._children[p] = t;
      }
      return self;
    }
    setChildren(value: any): ASXML {
      this.setProperty('*', false, value);
      return this;
    }
    setLocalName(name: any): void {

      notImplemented("public.XML::setLocalName"); return;
    }
    // 13.4.4.35 XML.prototype.setName( name )
    setName(name_: any): void {
      // Step 1.
      if (this._kind === ASXMLKind.Text || this._kind === ASXMLKind.Comment) {
        return;
      }
      // Step 2.
      if (name_ instanceof AS.ASQName && (<ASQName>name_).uri === null) {
        name_ = name_.localName;
      }
      // Step 3.
      var name: ASQName = new ASQName(name_);
      // Step 4.
      if (this._kind === ASXMLKind.ProcessingInstruction) {
        name.setUri('');
      }
      // Step 5.
      this._name = name;
      // Steps 6-8.
      var node = this;
      if (this._kind === ASXMLKind.Attribute) {
        if (this._parent === null) {
          return;
        }
        node = this._parent;
      }
      node.addInScopeNamespace(new AS.ASNamespace(name.uri));
    }
    setNamespace(ns: any): void {

      notImplemented("public.XML::setNamespace"); return;
    }
    text() {
      // 13.4.4.37 XML.prototype.text ( );
      var self: ASXML = this;
      var xl = AS.ASXMLList.createList(this, this._name);
      self._children && self._children.forEach(function (v, i) {
        if (v._kind === ASXMLKind.Text) {
          xl.append(v);
        }
      });
      return xl;
    }
    toXMLString(): string {
      return toXMLString(this);
    }
    toJSON(k: string) {
      return 'XML';
    }

    public static isTraitsOrDynamicPrototype(value): boolean {
      return value === ASXML.traitsPrototype || value === ASXML.dynamicPrototype;
    }

    asGetEnumerableKeys() {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return _asGetEnumerableKeys.call(this);
      }
      var keys = [];
      this._children.forEach(function (v, i) {
        keys.push(v.name);
      });
      return keys;
    }

    // 9.1.1.2 [[Put]] (P, V)
    setProperty(p, isAttribute, v) {
      // Step 1;
      if (p === p >>> 0) {
        Runtime.throwError('TypeError', Errors.XMLAssignmentToIndexedXMLNotAllowed);
      }
      // Step 2.
      if (this._kind === ASXMLKind.Text ||
          this._kind === ASXMLKind.Comment ||
          this._kind === ASXMLKind.ProcessingInstruction ||
          this._kind === ASXMLKind.Attribute) {
        return;
      }
      // Step 3.
      var c;
      if (!isXMLType(v) || v._kind === ASXMLKind.Text || v._kind === ASXMLKind.Attribute) {
        c = toString(v);
        // Step 4.
      } else {
        c = v._deepCopy();
      }
      // Step 5.
      var n = toXMLName(p);
      // Step 6.
      if (isAttribute) {
        // Step 6.a.
        if (!isXMLName(n.name)) {
          return;
        }
        // Step 6.b.
        if (c instanceof AS.ASXMLList) {
          // Step 6.b.i.
          if (c._children.length === 0) {
            c = '';
            // Step 6.b.ii.
          } else {
            // Step 6.b.ii.1.
            var s = toString(c._children[0]);
            // Step 6.b.ii.2.
            for (var j = 1; j < c._children.length; j++) {
              s += ' ' + toString(c._children[j]);
            }
            // Step 6.b.ii.3.
            c = s;
          }
          // Step 6.c.
        } else {
          c = asCoerceString(c);
        }
        // Step 6.d.
        var a: ASXML = null;
        // Step 6.e.
        var attributes = this._attributes;
        var newAttributes = this._attributes = [];
        for (var j = 0; attributes && j < attributes.length; j++) {
          var attribute = attributes[j];
          if (attribute._name.equals(n)) {
            // Step 6.e.1.
            if (!a) {
              a = attribute;
              // Step 6.e.2.
            } else {
              attribute._parent = null;
              continue;
            }
          }
          newAttributes.push(attribute);
        }
        // Step 6.f.
        if (!a) {
          a = createXML(ASXMLKind.Attribute, n.uri, n.localName);
          a._parent = this;
          newAttributes.push(a);
          // TODO: implement the namespace parts of step f.
        }
        // Step 6.g.
        a._value = c;
        // Step 6.h.
        return;
      }

      var i;
      var primitiveAssign = !isXMLType(c) && n.localName !== "*";
      var isAny = n.flags & ASQNameFlags.ANY_NAME;
      var isAnyNamespace = n.flags & ASQNameFlags.ANY_NAMESPACE;
      for (var k = this.length() - 1; k >= 0; k--) {
        if ((isAny || this._children[k]._kind === ASXMLKind.Element &&
          this._children[k]._name.localName === n.localName) &&
          (isAnyNamespace ||
            this._children[k]._kind === ASXMLKind.Element &&
            this._children[k]._name.uri === n.uri)) {
          if (i !== undefined) {
            this.deleteByIndex(i);
          }
          i = k;
        }
      }
      if (i === undefined) {
        i = this.length();
        if (primitiveAssign) {
          if (n.uri === null) {
            var name = new AS.ASQName(getDefaultNamespace(/* scope */), n);
          } else {
            var name = new AS.ASQName(n);
          }
          var y = createXML(ASXMLKind.Element, name.uri, name.localName, name.prefix);
          y._parent = this;
          var ns = name.getNamespace();
          this.replace(String(i), y);
          y.addInScopeNamespace(ns);
        }
      }
      if (primitiveAssign) {
        this._children[i]._children = [];   // blow away kids of x[i]
        var s = toString(c);
        if (s !== "") {
          this._children[i].replace("0", s);
        }
      } else {
        this.replace(String(i), c);
      }
    }

    public asSetProperty(namespaces: Namespace [], name: any, flags: number, value: any) {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return _asSetProperty.call(this, namespaces, name, flags, value);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      this.setProperty(prefixWithNamespace(namespaces, name, isAttribute), isAttribute, value);
    }


    // 9.1.1.1 XML.[[Get]] (P)
    getProperty(mn, isAttribute: boolean): any {
      // Step 1.
      if (isIndex(mn) || !Multiname.isQName(mn) && isNumeric(mn)) {
        // this is a shortcut to the E4X logic that wants us to create a new
        // XMLList with of size 1 and access it with the given index.
        if ((mn|0) === 0) {
          return this;
        }
        return null;
      }
      // Step 2.
      var name = toXMLName(mn);
      // Step 3.
      var list = AS.ASXMLList.createList(this, this._name);
      list._targetObject = this;
      list._targetProperty = name;
      var length = 0;
      var flags = name.name.flags;
      var anyName = flags & ASQNameFlags.ANY_NAME;
      var anyNamespace = flags & ASQNameFlags.ANY_NAMESPACE;

      // Step 4.
      isAttribute = isAttribute || !!(flags & ASQNameFlags.ATTR_NAME);
      if (isAttribute) {
        for (var i = 0; this._attributes && i < this._attributes.length; i++) {
          var v = this._attributes[i];
          if ((anyName || (v._name.localName === name.localName)) &&
              ((anyNamespace || v._name.uri === name.uri))) {
            list._children[length++] = v;
          }
        }
        return list;
      }
      // Step 5.
      for (var i = 0; this._children && i < this._children.length; i++) {
        var v = this._children[i];
        if ((anyName || v._kind === ASXMLKind.Element && v._name.localName === name.localName) &&
            ((anyNamespace || v._kind === ASXMLKind.Element && v._name.uri === name.uri))) {
          list._children[length++] = v;
        }
      }
      // Step 6.
      return list;
    }

    public asGetNumericProperty(name: number) {
      return this.asGetProperty(null, name, 0);
    }

    public asSetNumericProperty(name: number, value) {
      this.asSetProperty(null, name, 0, value);
    }

    public asGetProperty(namespaces: Namespace [], name: any, flags: number) {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return _asGetProperty.call(this, namespaces, name, flags);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      return this.getProperty(prefixWithNamespace(namespaces, name, isAttribute), isAttribute);
    }

    // 9.1.1.6 [[HasProperty]] (P) (well, very roughly)
    hasProperty(mn: any, isAttribute: boolean, isMethod: boolean) {
      if (isMethod) {
        var resolved = Multiname.isQName(mn) ? mn :
          this.resolveMultinameProperty(mn.namespaces, mn.name, mn.flags);
        return !!this[Multiname.getQualifiedName(resolved)];
      }
      if (isIndex(mn)) {
        // this is a shortcut to the E4X logic that wants us to create a new
        // XMLList of size 1 and access it with the given index.
        return Number(mn) === 0;
      }
      var name = toXMLName(mn);
      var flags = name.name.flags;
      var anyName = flags & ASQNameFlags.ANY_NAME;
      var anyNamespace = flags & ASQNameFlags.ANY_NAMESPACE;
      if (isAttribute) {
        for (var i = 0; this._attributes && i < this._attributes.length; i++) {
          var v = this._attributes[i];
          if ((anyName || (v._name.localName === name.localName) &&
                 (anyNamespace || v._name.uri === name.uri))) {
            return true;
          }
        }
        return false;
      }
      for (var i = 0; i < this._children.length; i++) {
        var v = this._children[i];
        if ((anyName || v._kind === ASXMLKind.Element && v._name.localName === name.localName) &&
            ((anyNamespace || v._kind === ASXMLKind.Element && v._name.uri === name.uri))) {
          return true;
        }
      }
    }

    deleteProperty(mn: Multiname, isAttribute: boolean) {
      if (isIndex(mn)) {
        // This hasn't ever been implemented and silently does nothing in Tamarin (and Rhino).
        return true;
      }
      var name = toXMLName(mn);
      var localName = name.localName;
      var uri = name.uri;
      var flags = name.name.flags;
      var anyName = flags & ASQNameFlags.ANY_NAME;
      var anyNamespace = flags & ASQNameFlags.ANY_NAMESPACE;
      if (isAttribute) {
        var attributes = this._attributes;
        if (attributes) {
          var newAttributes = this._attributes = [];
          for (var i = 0; i < attributes.length; i++) {
            var node = attributes[i];
            var attrName = node._name;
            if ((anyName || attrName.localName === localName) &&
                (anyNamespace || attrName.uri === uri)) {
              node._parent = null;
            } else {
              newAttributes.push(node);
            }
          }
        }
      } else {
        if (this._children.some(function (v, i): any {
          return ((anyName || v._kind === ASXMLKind.Element && v._name.localName === name.localName) &&
            ((anyNamespace || v._kind === ASXMLKind.Element && v._name.uri === name.uri)));
        })) {
          return true;
        }
      }
    }

    public asHasProperty(namespaces: Namespace [], name: any, flags: number) {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return _asHasProperty.call(this, namespaces, name, flags);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      name = prefixWithNamespace(namespaces, name, isAttribute);
      if (this.hasProperty(name, isAttribute, false)) {
        return true;
      }

      // HACK if child with specific name is not present, check object's attributes.
      // The presence of the attribute/method can be checked during with(), see #850.
      var resolved = Multiname.isQName(name) ? name :
        this.resolveMultinameProperty(namespaces, name, flags);
      return !!this[Multiname.getQualifiedName(resolved)];
    }

    _asDeleteProperty(namespaces: Namespace [], name: any, flags: number) {
      if (ASXML.isTraitsOrDynamicPrototype(this)) {
        return _asDeleteProperty.call(this, namespaces, name, flags);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      name = prefixWithNamespace(namespaces, name, isAttribute);
      if (this.deleteProperty(name, isAttribute)) {
        return true;
      }

      // HACK if child with specific name is not present, check object's attributes.
      // The presence of the attribute/method can be checked during with(), see #850.
      var resolved = Multiname.isQName(name) ? name :
        this.resolveMultinameProperty(namespaces, name, flags);
      return delete this[Multiname.getQualifiedName(resolved)];
    }

    public asHasPropertyInternal(namespaces: Namespace [], name: any, flags: number) {
      return this.asHasProperty(namespaces, name, flags);
    }

    asCallProperty(namespaces: Namespace [], name: any, flags: number, isLex: boolean, args: any []) {
      if (ASXML.isTraitsOrDynamicPrototype(this) || isLex) {
        return _asCallProperty.call(this, namespaces, name, flags, isLex, args);
      }
      // Checking if the method exists before calling it
      var method;
      var resolved = this.resolveMultinameProperty(namespaces, name, flags);
      method = this.asOpenMethods[resolved] || this[resolved];
      if (method) {
        return method.apply(isLex ? null : this, args);
      }
      // Otherwise, 11.2.2.1 CallMethod ( r , args )
      // If f == undefined and Type(base) is XMLList and base.[[Length]] == 1
      //   ii. Return the result of calling CallMethod(r0, args) recursively

      // f. If f == undefined and Type(base) is XML and base.hasSimpleContent () == true
      //   i. Let r0 be a new Reference with base object = ToObject(ToString(base)) and property
      // name = P ii. Return the result of calling CallMethod(r0, args) recursively
      if (this.hasSimpleContent()) {
        return Object(toString(this)).asCallProperty(namespaces, name, flags, isLex, args);
      }
      throwError('TypeError', Errors.CallOfNonFunctionError, 'value');
    }

    _delete(key, isMethod) {
      notImplemented("XML.[[Delete]]");
    }

    deleteByIndex (p: number) {
      var i = p >>> 0;
      if (String(i) !== String(p)) {
        throw "TypeError in XML.prototype.deleteByIndex(): invalid index " + p;
      }
      var children = this._children;
      if (p < children.length && children[p]) {
        children[p]._parent = null;
        children.splice(p, 1);
      }
    }

    // 9.1.1.11 [[Insert]] (P, V)
    insert(p, v) {
      var s, i, n;
      var self: ASXML = this;
      if (self._kind === ASXMLKind.Text ||
          self._kind === ASXMLKind.Comment ||
          self._kind === ASXMLKind.ProcessingInstruction ||
          self._kind === ASXMLKind.Attribute) {
        return;
      }
      i = p >>> 0;
      if (String(p) !== String(i)) {
        throw "TypeError in XML.prototype.insert(): invalid property name " + p;
      }
      if (self._kind === ASXMLKind.Element) {
        var a = self;
        while (a) {
          if (a === v) {
            throw "Error in XML.prototype.insert()";
          }
          a = a._parent;
        }
      }
      if (self instanceof ASXMLList) {
        n = self.length();
        if (n === 0) {
          return;
        }
      } else {
        n = 1;
      }
      for (var j = self.length() - 1; j >= i; j--) {
        self._children[j + n] = self._children[j];
      }
      if (self instanceof ASXMLList) {
        n = v.length();
        for (var j = 0; j < n; j++) {
          v._children[j]._parent = self;
          self[i + j] = v[j];
        }
      } else {
        //x.replace(i, v);
        v._parent = self;
        if (!self._children) {
          self._children = [];
        }
        self._children[i] = v;
      }
    }

    // 9.1.1.13 [[AddInScopeNamespace]] ( N )
    addInScopeNamespace(ns: ASNamespace) {
      var s;
      var self: ASXML = this;
      if (self._kind === ASXMLKind.Text ||
          self._kind === ASXMLKind.Comment ||
          self._kind === ASXMLKind.ProcessingInstruction ||
          self._kind === ASXMLKind.Attribute) {
        return;
      }
      if (ns.prefix !== undefined) {
        if (ns.prefix === "" && self._name.uri === "") {
          return;
        }
        var match = null;
        self._inScopeNamespaces.forEach(function (v, i) {
          if (v.prefix === ns.prefix) {
            match = v;
          }
        });
        if (match !== null && match.uri !== ns.uri) {
          self._inScopeNamespaces.forEach(function (v, i) {
            if (v.prefix === match.prefix) {
              self._inScopeNamespaces[i] = ns;  // replace old with new
            }
          });
        }
        if (self._name.prefix === ns.prefix) {
          self._name.prefix = undefined;
        }
        self._attributes.forEach(function (v, i) {
          if (v._name.prefix === ns.prefix) {
            v._name.prefix = undefined;
          }
        });
      }
    }

    descendantsInto(name: ASQName, xl: ASXMLList) {
      var flags = name.flags;
      var self: ASXML = this;
      if (self._kind !== ASXMLKind.Element) {
        return xl;
      }
      var length = xl._children.length;
      var localName = name.localName;
      var uri = name.uri;
      var isAny = flags & ASQNameFlags.ANY_NAME;
      if (flags & ASQNameFlags.ATTR_NAME) {
        // Get attributes
        this._attributes.forEach(function (v, i) {
          if (isAny || localName === v._name.localName && uri === v._name.uri) {
            xl._children[length++] = v;
          }
        });
      } else {
        // Get children
        this._children.forEach(function (v, i) {
          if (isAny || localName === v._name.localName && uri === v._name.uri) {
            xl._children[length++] = v;
          }
        });
      }
      // Descend
      this._children.forEach(function (v, i) {
        v.descendantsInto(name, xl);
      });
      return xl;
    }
  }

  function createXML(kind?: ASXMLKind, uri?, name?, prefix?): ASXML {
    var xml = new AS.ASXML();
    if (kind === undefined) {
      kind = ASXMLKind.Text;
    }
    if (uri === undefined) {
      uri = "";
    }
    if (name === undefined) {
      name = "";
    }
    xml.init(kind, uri, name, prefix);
    return xml;
  }

  export class ASXMLList extends ASNative implements XMLType {
    public static instanceConstructor: any = ASXMLList;
    static classInitializer: any = function() {
      defineNonEnumerableProperty(this, '$Bglength', 1);

      var proto: any = ASXMLList.prototype;
      defineNonEnumerableProperty(proto, 'asDeleteProperty', proto._asDeleteProperty);
      defineNonEnumerableProperty(proto, '$BgvalueOf', Object.prototype['$BgvalueOf']);
      defineNonEnumerableProperty(proto, '$BghasOwnProperty', proto.native_hasOwnProperty);
      defineNonEnumerableProperty(proto, '$BgpropertyIsEnumerable',
                                  proto.native_propertyIsEnumerable);

      createPublicAliases(proto, [
        'toString',
        'addNamespace',
        'appendChild',
        'attribute',
        'attributes',
        'child',
        'childIndex',
        'children',
        'comments',
        'contains',
        'copy',
        'descendants',
        'elements',
        'hasComplexContent',
        'hasSimpleContent',
        'inScopeNamespaces',
        'insertChildAfter',
        'insertChildBefore',
        'length',
        'localName',
        'name',
        'namespace',
        'namespaceDeclarations',
        'nodeKind',
        'normalize',
        'parent',
        'processingInstructions',
        'prependChild',
        'removeNamespace',
        'replace',
        'setChildren',
        'setLocalName',
        'setName',
        'setNamespace',
        'text',
        'toXMLString',
        'toJSON'
      ]);
    };

    public static callableConstructor: any = function (value: any): ASXMLList {
      // 13.5.1 The XMLList Constructor Called as a Function
      if (isNullOrUndefined(value)) {
        value = '';
      }
      if (value instanceof ASXMLList) {
        return value;
      }
      var list = new AS.ASXMLList();
      toXMLList(value, list);
      return list;
    }

    // 11.4.1 The Addition Operator ( + )
    public static addXML(left: ASXMLList, right: ASXMLList) {
      var result: ASXMLList;
      if (left instanceof ASXML) {
        result = new AS.ASXMLList();
        result.append(left);
      } else {
        result = left;
      }
      result.append(right);
      return result;
    }

    _children: ASXML [];
    _targetObject: any; // ASXML|ASXMLList
    _targetProperty: ASQName;

    constructor (value?: any) {
      false && super();
      this._children = [];

      if (isNullOrUndefined(value)) {
        value = "";
      }
      if (!value) {
        return;
      }

      if (value instanceof ASXMLList) {
        var children = (<ASXMLList>value)._children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          this._children[i] = child;
        }
      } else {
        toXMLList(value, this);
      }
    }

    static createList(targetObject: AS.ASXML = null, targetProperty: AS.ASQName = null) {
      var list = new AS.ASXMLList();
      list._targetObject = targetObject;
      list._targetProperty = targetProperty;
      return list;
    }

    valueOf() {
      return this;
    }

    // E4X 11.5.1 The Abstract Equality Comparison Algorithm, steps 1-2.
    // (but really 9.2.1.9 [[Equals]] (V))
    equals(other: any): boolean {
      var children = this._children;
      // Step 1.
      if (other === undefined && children.length === 0) {
        return true;
      }
      // Step 2.
      if (other instanceof ASXMLList) {
        var otherChildren = other._children;
        // Step 2.a.
        if (otherChildren.length !== children.length) {
          return false;
        }
        // Step 2.b.
        for (var i = 0; i < children.length; i++) {
          if (!children[i].equals(otherChildren[i])) {
            return false;
          }
        }
        // Step 2.c.
        return true;
      }
      // Steps 3-4.
      return children.length === 1 && children[0].equals(other);
    }

    toString(): string {
      if (this.hasComplexContent()) {
        return this.toXMLString();
      }
      var s = '';
      for (var i = 0; i < this._children.length; i++) {
        s += toString(this._children[i]);
      }
      return s;
    }

    // 9.2.1.7 [[DeepCopy]] ( )
    _deepCopy() {
      var xl = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      var length = this.length();
      for (var i = 0; i < length; i++) {
        xl._children[i] = this._children[i]._deepCopy();
      }
      return xl;
    }

    _shallowCopy() {
      var xl = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      var length = this.length();
      for (var i = 0; i < length; i++) {
        xl._children[i] = this._children[i];
      }
      return xl;
    }

    // 13.5.4.12 XMLList.prototype.hasOwnProperty ( P )
    native_hasOwnProperty(P: string): boolean {
      P = asCoerceString(P);
      if (ASXMLList.isTraitsOrDynamicPrototype(this)) {
        return ASObject.prototype.native_hasOwnProperty.call(this, P);
      }
      if (isIndex(P)) {
        return (<any>P|0) < this._children.length;
      }

      var mn = toXMLName(P);
      var isAttribute = !!(mn.flags & ASQNameFlags.ATTR_NAME);
      var children = this._children;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        if (node._kind === ASXMLKind.Element) {
          if (node.hasProperty(mn, isAttribute, false)) {
            return true;
          }
        }
      }
      return false;
    }
    // 13.5.4.19 XMLList.prototype.propertyIsEnumerable ( P )
    native_propertyIsEnumerable(P: any): boolean {
      return isIndex(P) && (P|0) < this._children.length;
    }
    attribute(arg: any): ASXMLList {
      return this.getProperty(arg, true);
    }
    attributes(): ASXMLList {
      // 13.5.4.3 XMLList.prototype.attributes ( )
      return this.getProperty('*', true);
    }
    child(propertyName: any): ASXMLList {
      if (isIndex(propertyName)) {
        var list = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
        if (propertyName < this._children.length) {
          list._children[0] = this._children[propertyName | 0]._deepCopy();
        }
        return list;
      }
      return this.getProperty(propertyName, false);
    }
    children(): ASXMLList {
      // 13.5.4.4 XMLList.prototype.child ( propertyName )
      return this.getProperty('*', false);
    }
    // 9.2.1.8 [[Descendants]] (P)
    descendants(name_: any): ASXMLList {
      var name = toXMLName(name_);
      var list = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      for (var i = 0; i < this._children.length; i++) {
        var child = this._children[i];
        if (child._kind === ASXMLKind.Element) {
          child.descendantsInto(name, list);
        }
      }
      return list;
    }
    comments(): ASXMLList {
      // 13.5.4.6 XMLList.prototype.comments ( )
      var xl = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      this._children.forEach(function (child) {
        if ((<any> child)._kind === ASXMLKind.Element) {
          var r = child.comments();
          Array.prototype.push.apply(xl._children, r._children);
        }
      });
      return xl;
    }

    // 13.5.4.8 XMLList.prototype.contains ( value )
    contains(value: any): boolean {
      var children = this._children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.equals(value)) {
          return true;
        }
      }
      return false;
    }
    copy(): ASXMLList {
      // 13.5.4.9 XMLList.prototype.copy ( )
      return this._deepCopy();
    }
    elements(name: any = "*"): ASXMLList {
      // 13.5.4.11 XMLList.prototype.elements ( [ name ] )
      var mn = toXMLName(name);
      var xl = AS.ASXMLList.createList(this._targetObject, mn);
      this._children.forEach(function (child) {
        if ((<any> child)._kind === ASXMLKind.Element) {
          var r = child.elements(mn);
          Array.prototype.push.apply(xl._children, r._children);
        }
      });
      return xl;
    }
    hasComplexContent(): boolean {
      // 13.5.4.13 XMLList.prototype.hasComplexContent( )
      switch (this.length()) {
        case 0:
          return false;
        case 1:
          return this._children[0].hasComplexContent();
        default:
          return this._children.some(function (child) {
            return (<any> child)._kind === ASXMLKind.Element;
          });
      }
    }
    hasSimpleContent(): boolean {
      // 13.5.4.14 XMLList.prototype.hasSimpleContent( )
      switch (this.length()) {
        case 0:
          return true;
        case 1:
          return this._children[0].hasSimpleContent();
        default:
          return this._children.every(function (child) {
            return (<any> child)._kind !== ASXMLKind.Element;
          });
      }
    }
    length(): number /*int*/ {
      return this._children.length;
    }
    name(): Object {
      return this._children[0].name();
    }

    // 13.5.4.16 XMLList.prototype.normalize ( )
    normalize(): ASXMLList {
      // Steps 1-2.
      for (var i = 0; i < this._children.length;) {
        var child = this._children[i];
        // Step 2.a.
        if (child._kind === ASXMLKind.Element) {
          child.normalize();
          i++;
        }
        // Step 2.b.
        else if (child._kind === ASXMLKind.Text) {
          // Step 2.b.i.
          for (i++; i < this._children.length;) {
            var nextChild = this._children[i];
            if (nextChild._kind !== ASXMLKind.Text) {
              break;
            }
            child._value += nextChild._value;
            this.removeByIndex(i);
          }
          // Step 2.b.ii.
          if (child._value.length === 0) {
            this.removeByIndex(i);
          }
          // Step 2.b.iii.
          else {
            i++;
          }
        }
        // Step 2.c.
        else {
          i++;
        }
      }
      return this;
    }

    parent(): any {
      // 13.5.4.17 XMLList.prototype.parent ( )
      var children = this._children;
      if (children.length === 0) {
        return undefined;
      }
      var parent = children[0]._parent;
      for (var i = 1; i < children.length; i++) {
        if (children[i]._parent !== parent) {
          return undefined;
        }
      }
      return parent;
    }
    // 13.5.4.18 XMLList.prototype.processingInstructions ( [ name ] )
    processingInstructions(name: any = "*"): ASXMLList {
      // (Numbering in the spec starts at 6.)
      // Step 6 (implicit).
      // Step 7.
      var localName = toXMLName(name).localName;
      // Step 8.
      var list = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      list._targetObject = this;
      list._targetProperty = null;
      // Step 9.
      var children = this._children;
      for (var i = 0; i < children.length; i++) {
        children[i].processingInstructionsInto(name, localName, list);
      }
      // Step 10.
      return list;
    }
    text(): ASXMLList {
      // 13.5.4.20 XMLList.prototype.text ( )
      var xl = AS.ASXMLList.createList(this._targetObject, this._targetProperty);
      this._children.forEach(function (v:any, i) {
        if (v._kind === ASXMLKind.Element) {
          var gq = v.text();
          if (gq.length() > 0) {
            xl._children.push(gq);
          }
        }
      });
      return xl;
    }
    toXMLString(): string {
      return toXMLString(this);
    }
    toJSON(k: string) {
      return 'XMLList';
    }
    addNamespace(ns: any): ASXML {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'addNamespace');
      }
      var xml = this._children[0];
      xml.addNamespace(ns);
      return xml;
    }
    appendChild(child: any) {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'appendChild');
      }
      var xml = this._children[0];
      xml.appendChild(child);
      return xml;
    }

    // 9.2.1.6 [[append]] (V)
    append(V: any) {
      // Step 1.
      var children = this._children;
      var i = children.length;
      // Step 2.
      var n = 1;
      // Step 3.
      if (V instanceof AS.ASXMLList) {
        this._targetObject = V._targetObject;
        this._targetProperty = V._targetProperty;
        var valueChildren: ASXML[] = V._children;
        n = valueChildren.length;
        if (n === 0) {
          return;
        }
        for (var j = 0; j < valueChildren.length; j++) {
          children[i + j] = valueChildren[j];
        }
        return;
      }
      release || assert(V instanceof AS.ASXML);
      // Step 4.
      children[i] = V;
      this._targetProperty = V._name;
      // Step 5 (implicit).
    }

    childIndex(): number /*int*/ {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'childIndex');
      }
      return this._children[0].childIndex();
    }
    inScopeNamespaces(): any [] {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'inScopeNamespaces');
      }
      return this._children[0].inScopeNamespaces();
    }
    insertChildAfter(child1: any, child2: any): any {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'insertChildAfter');
      }
      return this._children[0].insertChildAfter(child1, child2);
    }
    insertChildBefore(child1: any, child2: any): any {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'insertChildBefore');
      }
      return this._children[0].insertChildBefore(child1, child2);
    }
    nodeKind(): string {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'nodeKind');
      }
      return this._children[0].nodeKind();
    }
    namespace(prefix: string): any {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'namespace');
      }
      var firstChild = this._children[0];
      return arguments.length ? firstChild.namespace(prefix) : firstChild.namespace();
    }
    localName(): Object {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'localName');
      }
      return this._children[0].localName();
    }
    namespaceDeclarations(): any [] {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists,
                           'namespaceDeclarations');
      }
      return this._children[0].namespaceDeclarations();
    }
    prependChild(value: any): ASXML {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'prependChild');
      }
      return this._children[0].prependChild(value);
    }
    removeNamespace(ns: any): ASXML {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'removeNamespace');
      }
      return this._children[0].removeNamespace(ns);
    }
    replace(propertyName: any, value: any): ASXML {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'replace');
      }
      return this._children[0].replace(propertyName, value);
    }
    setChildren(value: any): ASXML {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'setChildren');
      }
      return this._children[0].setChildren(value);
    }
    setLocalName(name: any): void {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'setLocalName');
      }
      return this._children[0].setLocalName(name);
    }
    setName(name: any): void {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'setName');
      }
      return this._children[0].setName(name);
    }
    setNamespace(ns: any): void {
      if (this._children.length !== 1) {
        Runtime.throwError('TypeError', Errors.XMLOnlyWorksWithOneItemLists, 'setNamespace');
      }
      return this._children[0].setNamespace(ns);
    }

    public static isTraitsOrDynamicPrototype(value): boolean {
      return value === ASXMLList.traitsPrototype || value === ASXMLList.dynamicPrototype;
    }

    asGetEnumerableKeys() {
      if (ASXMLList.isTraitsOrDynamicPrototype(this)) {
        return _asGetEnumerableKeys.call(this);
      }
      return this._children.asGetEnumerableKeys();
    }

    // 9.2.1.1 [[Get]] (P)
    getProperty(mn, isAttribute): any {
      if (isIndex(mn)) {
        return this._children[mn];
      }
      var name = toXMLName(mn);
      var xl = AS.ASXMLList.createList(this._targetObject, name);
      this._children.forEach(function (v:any, i) {
        // a. If x[i].[[Class]] == "element",
        if (v._kind === ASXMLKind.Element) {
          // i. Let gq be the result of calling the [[Get]] method of x[i] with argument P
          var gq = v.getProperty(name, isAttribute);
          // ii. If gq.[[Length]] > 0, call the [[append]] method of list with argument gq
          if (gq.length() > 0) {
            var descendants = gq._children;
            for (var j = 0; j < descendants.length; j++) {
              xl._children.push(descendants[j]);
            }
          }
        }
      });
      return xl;
    }

    public asGetNumericProperty(name: number) {
      return this.asGetProperty(null, name, 0);
    }

    public asSetNumericProperty(name: number, value) {
      this.asSetProperty(null, name, 0, value);
    }

    public asGetProperty(namespaces: Namespace [], name: any, flags: number) {
      if (ASXMLList.isTraitsOrDynamicPrototype(this)) {
        return _asGetProperty.call(this, namespaces, name, flags);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      return this.getProperty(prefixWithNamespace(namespaces, name, isAttribute), isAttribute);
    }

    hasProperty(mn, isAttribute) {
      if (isIndex(mn)) {
        return Number(mn) < this._children.length;
      }
      // TODO scan children on property presence?
      return true;
    }

    public asHasProperty(namespaces: Namespace [], name: any, flags: number) {
      if (ASXMLList.isTraitsOrDynamicPrototype(this)) {
        return _asGetProperty.call(this, namespaces, name, flags);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      return this.hasProperty(prefixWithNamespace(namespaces, name, isAttribute),
        isAttribute);
    }

    public asHasPropertyInternal(namespaces: Namespace [], name: any, flags: number) {
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      return this.hasProperty(prefixWithNamespace(namespaces, name, isAttribute),
        isAttribute);
    }

    // 9.1.1.10 [[ResolveValue]] ( )
    resolveValue() {
      return this;
    }

    // 9.2.1.2 [[Put]] (P, V)
    setProperty(mn, isAttribute, value) {
      // Steps 1-2.
      if (isIndex(mn)) {
        var i = mn|0;
        // Step 2.b.
        var r: any = null;
        // Step 2.a.
        if (this._targetObject) {
          r = this._targetObject.resolveValue();
          if (r === null) {
            return;
          }
        }
        // Step 2.c.
        var length = this.length();
        if (i >= length) {
          // Step 2.c.i.
          if (r instanceof AS.ASXMLList) {
            // Step 2.c.i.1.
            if (r.length() !== 1) {
              return;
            }
            // Step 2.c.i.2.
            r = r._children[0];
          }
          release || assert(r === null || r instanceof AS.ASXML);
          // Step 2.c.ii.
          if (r && r._kind !== ASXMLKind.Element) {
            return;
          }
          // Step 2.c.iii.
          var y = new AS.ASXML();
          y._parent = r;
          y._name = this._targetProperty;
          // Step 2.c.iv.
          if (isQNameAttribute(this._targetProperty)) {
            if (r.hasProperty(this._targetProperty, true, false)) {
              return;
            }
            y._kind = ASXMLKind.Attribute;
          }
          // Step 2.c.v.
          else if (isNullOrUndefined(this._targetProperty) ||
                   this._targetProperty.localName === '*') {
            y._name = null;
            y._kind = ASXMLKind.Text;
          }
          // Step 2.c.vi.
          else {
            y._kind = ASXMLKind.Element;
          }
          // Step 2.c.vii.
          i = length;
          // Step 2.c.viii.
          if (y._kind !== ASXMLKind.Attribute) {
            // Step 2.c.viii.1.
            if (r !== null) {
              var j: number;
              // Step 2.c.viii.1.a.
              if (i > 0) {
                var lastChild = this._children[i - 1];
                for (j = 0; j < r.length - 1; j++) {
                  if (r._children[j] === lastChild) {
                    break;
                  }
                }
              }
              // Step 2.c.viii.1.b.
              else {
                j = r.length() - 1;
              }
              // Step 2.c.viii.1.c.
              r._children[j + 1] = y;
              y._parent = r;
            }
            // Step 2.c.viii.2.
            if (value instanceof AS.ASXML) {
              y._name = value._name;
            }
            // Step 2.c.viii.3.
            else if (value instanceof AS.ASXMLList) {
              y._name = value._targetProperty;
            }
            // Step 2.c.ix.
            this.append(y);
          }
        }
        // Step 2.d.
        if (!isXMLType(value) ||
            value._kind === ASXMLKind.Text || value._kind === ASXMLKind.Attribute) {
          value = value + '';
        }
        var currentChild = this._children[i];
        var childKind = currentChild._kind;
        var parent = currentChild._parent;
        // Step 2.e.
        if (childKind === ASXMLKind.Attribute) {
          var indexInParent = parent._children.indexOf(currentChild);
          parent.setProperty(currentChild._name, true, false);
          this._children[i] = parent._children[indexInParent];
          return;
        }
        // Step 2.f.
        if (value instanceof AS.ASXMLList) {
          // Step 2.f.i.
          var c = value._shallowCopy();
          var cLength = c.length();
          // Step 2.f.ii. (implemented above.)
          // Step 2.f.iii.
          if (parent !== null) {
            // Step 2.f.iii.1.
            var q = parent._children.indexOf(currentChild);
            // Step 2.f.iii.2.
            parent.replace(q, c);
            // Step 2.f.iii.3.
            for (var j = 0; j < cLength; j++) {
              c.setProperty(j, false, parent._children[q + j]);
            }
          }
          // Step 2.f.iv.
          if (cLength === 0) {
            for (var j = i + 1; j < length; j++) {
              this._children[j - 1] = this._children[j];
            }
            // Step 2.f.vii. (only required if we're shrinking the XMLList.
            this._children.length--;
          }
          // Step 2.f.v.
        else {
            for (var j = length - 1; j > i; j--) {
              this._children[j + cLength - 1] = this._children[j];
            }
          }
          // Step 2.f.vi.
          for (var j = 0; j < cLength; j++) {
            this._children[i + j] = c._children[j];
          }
          return;
        }
        // Step 2.g.
        if (value instanceof AS.ASXML || childKind >= ASXMLKind.Text) {
          // Step 2.g.i. (implemented above.)
          // Step 2.g.ii.
          if (parent !== null) {
            // Step 2.g.iii.1.
            var q = parent._children.indexOf(currentChild);
            // Step 2.g.iii.2.
            parent.replace(q, c);
            // Step 2.g.iii.3.
            value = parent._children[q];
          }
          // Step 2.g.iii.
          if (typeof value === 'string') {
            var t = new AS.ASXML(value);
            this._children[i] = t;
          }
          // Step 2.g.iv.
          else {
            this._children[i] = value;
          }
          return;
        }
        // Step 2.h.
        currentChild.setProperty('*', false, value);
        return;
      }
      // Step 3.
      if (this._children.length === 0) {
        // Step 3.a.i.
        r = this.resolveValue();
        // Step 3.a.ii.
        if (r === null || r._children.length !== 1) {
          return;
        }
        // Step 3.a.iii.
        this.append(r._children[0]);
      }
      // Step 3.b.
      if (this._children.length === 1) {
        this._children[0].setProperty(mn, isAttribute, value);
        // Step 4.
        return;
      }
      // Not in the spec, but in Flash.
      Runtime.throwError('TypeError', Errors.XMLAssigmentOneItemLists);
    }

    public asSetProperty(namespaces: Namespace [], name: any, flags: number, value: any) {
      if (ASXMLList.isTraitsOrDynamicPrototype(this)) {
        return _asSetProperty.call(this, namespaces, name, flags, value);
      }
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      name = prefixWithNamespace(namespaces, name, isAttribute);
      return this.setProperty(name, isAttribute, value);
    }

    // 9.2.1.3 [[Delete]] (P)
    _asDeleteProperty(namespaces: Namespace [], name: any, flags: number) {
      // Steps 1-2.
      if (isIndex(name)) {
        var i = name|0;
        // Step 2.a.
        if (i >= this._children.length) {
          return true;
        }
        // Step 2.b.
        this.removeByIndex(i);
        return true;
      }
      // Step 3.
      var isAttribute = !!(flags & Multiname.ATTRIBUTE);
      name = prefixWithNamespace(namespaces, name, isAttribute);
      for (var i = 0; i < this._children.length; i++) {
        var child = this._children[i];
        if (child._kind === ASXMLKind.Element) {
          child.deleteProperty(name, isAttribute);
        }
      }
      // Step 4.
      return true;
    }

    private removeByIndex(index: number) {
      var child = this._children[index];
      var parent = child._parent;
      if (parent) {
        child._parent = null;
        parent._children.splice(parent._children.indexOf(child), 1);
      }
      this._children.splice(index, 1);
    }

    asCallProperty(namespaces: Namespace [], name: any, flags: number, isLex: boolean, args: any []) {
      if (ASXMLList.isTraitsOrDynamicPrototype(this) || isLex) {
        return _asCallProperty.call(this, namespaces, name, flags, isLex, args);
      }
      // Checking if the method exists before calling it
      var method;
      var resolved = this.resolveMultinameProperty(namespaces, name, flags);
      method = this.asOpenMethods[resolved] || this[resolved];
      if (method) {
        return method.apply(isLex ? null : this, args);
      }
      // Otherwise, 11.2.2.1 CallMethod ( r , args )
      // If f == undefined and Type(base) is XMLList and base.[[Length]] == 1
      //   ii. Return the result of calling CallMethod(r0, args) recursively
      if (this.length() === 1) {
        return this._children[0].asCallProperty(namespaces, name, flags, isLex, args);
      }
      throwError('TypeError', Errors.CallOfNonFunctionError, 'value');
    }
  }
}
