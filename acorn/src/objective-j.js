import {Parser} from "./state.js"
import {types as tt, objjAtTypes as oatt, objjTypes as ott} from "./tokentype.js"
import {functionFlags} from "./scopeflags.js"

const pp = Parser.prototype

pp.parseObjjImplementation = function(node) {
  this.next()
  node.classname = this.parseIdent(true)
  if (this.eat(tt.colon))
    node.superclassname = this.parseIdent(true)
  else if (this.eat(tt.parenL)) {
    node.categoryname = this.parseIdent(true)
    this.expect(tt.parenR, "Expected closing ')' after category name")
  }
  if (this.value === "<") {
    this.next()
    let protocols = [],
        first = true
    node.protocols = protocols
    while (this.value !== ">") {
      if (!first)
        this.expect(tt._comma, "Expected ',' between protocol names")
      else first = false
      protocols.push(this.parseIdent(true))
    }
    this.next()
  }
  if (this.eat(tt.braceL)) {
    node.ivardeclarations = []
    for (;;) {
      if (this.eat(tt.braceR)) break
      this.parseObjjIvarDeclaration(node)
    }
    node.endOfIvars = this.start
  }
  node.body = []
  while (!this.eat(oatt._end)) {
    if (this.type === tt.eof) this.raise(this.pos, "Expected '@end' after '@implementation'")
    node.body.push(this.parseObjjClassElement())
  }
  return this.finishNode(node, "ClassDeclarationStatement")
}

pp.parseObjjInterface = function(node) {
  this.next()
  node.classname = this.parseIdent(true)
  if (this.eat(tt.colon))
    node.superclassname = this.parseIdent(true)
  else if (this.eat(tt.parenL)) {
    node.categoryname = this.parseIdent(true)
    this.expect(tt.parenR, "Expected closing ')' after category name")
  }
  if (this.value === "<") {
    this.next()
    let protocols = [],
        first = true
    node.protocols = protocols
    while (this.value !== ">") {
      if (!first)
        this.expect(tt.comma, "Expected ',' between protocol names")
      else first = false
      protocols.push(this.parseIdent(true))
    }
    this.next()
  }
  if (this.eat(tt.braceL)) {
    node.ivardeclarations = []
    for (;;) {
      if (this.eat(tt.braceR)) break
      this.parseObjjIvarDeclaration(node)
    }
    node.endOfIvars = this.start
  }
  node.body = []
  while (!this.eat(oatt._end)) {
    if (this.type === tt.eof) this.raise(this.pos, "Expected '@end' after '@interface'")
    node.body.push(this.parseClassElement())
  }
  return this.finishNode(node, "InterfaceDeclarationStatement")
}

pp.parseObjjProtocol = function(node) {
  this.next()
  node.protocolname = this.parseIdent(true)
  if (this.value === "<") {
    this.next()
    let protocols = [],
        first = true
    node.protocols = protocols
    while (this.value !== ">") {
      if (!first)
        this.expect(tt.comma, "Expected ',' between protocol names")
      else first = false
      protocols.push(this.parseIdent(true))
    }
    this.next()
  }
  while (!this.eat(oatt._end)) {
    if (this.type === tt.eof) this.raise(this.pos, "Expected '@end' after '@protocol'")
    if (this.eat(oatt._required)) continue
    if (this.eat(oatt._optional)) {
      while (!this.eat(oatt._required) && this.type !== oatt._end) {
        (node.optional || (node.optional = [])).push(this.parseObjjProtocolClassElement())
      }
    } else {
      (node.required || (node.required = [])).push(this.parseObjjProtocolClassElement())
    }
  }
  return this.finishNode(node, "ProtocolDeclarationStatement")
}

pp.parseObjjProtocolClassElement = function() {
  let element = this.startNode()
  this.parseObjjMethodDeclaration(element)

  this.semicolon()
  return this.finishNode(element, "MethodDeclarationStatement")
}

pp.parseObjjMethodDeclaration = function(node) {
  node.methodtype = this.value
  this.expect(tt.plusMin, "Method declaration must start with '+' or '-'")
  // If we find a '(' we have a return type to parse
  if (this.eat(tt.parenL)) {
    let typeNode = this.startNode()
    if (this.eat(oatt._action) || this.eat(ott._action)) { // TODO: Something is not right here, are there two types of action tokens?
      node.action = this.finishNode(typeNode, "ObjectiveJActionType")
      typeNode = this.startNode()
    }
    if (!this.eat(tt.parenR)) {
      node.returntype = this.parseObjectiveJType(typeNode, true)
      this.expect(tt.parenR, "Expected closing ')' after method return type")
    }
  }
  // Now we parse the selector
  let first = true,
      selectors = [],
      args = []
  node.selectors = selectors
  node.arguments = args
  for (;;) {
    if (this.type !== tt.colon) {
      selectors.push(this.parseIdent(true))
      if (first && this.type !== tt.colon) break
    } else
      selectors.push(null)
    this.expect(tt.colon, "Expected ':' in selector")
    let argument = {}
    args.push(argument)
    if (this.eat(tt.parenL)) {
      argument.type = this.parseObjectiveJType()
      this.expect(tt.parenR, "Expected closing ')' after method argument type")
    }
    argument.identifier = this.parseIdent(false)
    if (this.type === tt.braceL || this.type === tt.semi) break
    if (this.eat(tt.comma)) {
      this.expect(tt.ellipsis, "Expected '...' after ',' in method declaration")
      node.parameters = true
      break
    }
    first = false
  }
}

pp.parseObjjImport = function(node) {
  this.next()
  if (this.type === tt.string)
    node.localfilepath = true
  else if (this.type === ott._filename)
    node.localfilepath = false
  else
    this.unexpected()

  node.filename = this.parseObjjStringNumRegExpLiteral()
  return this.finishNode(node, "ImportStatement")
}

pp.parseObjjStringNumRegExpLiteral = function() {
  let node = this.startNode()
  node.value = this.value
  node.raw = this.tokInput.slice(this.start, this.end)
  this.next()
  return this.finishNode(node, "Literal")
}

pp.parseObjjIvarDeclaration = function(node) {
  let outlet
  if (this.eat(oatt._outlet))
    outlet = true
  let type = this.parseObjectiveJType()
  if (this.strict && this.reservedWordsStrictBind.test(type.name))
    this.raise(type.start, "Binding " + type.name + " in strict mode")
  for (;;) {
    let decl = this.startNode()
    if (outlet)
      decl.outlet = outlet
    decl.ivartype = type
    decl.id = this.parseIdent()
    if (this.strict && this.reservedWordsStrictBind.test(decl.id.name))
      this.raise(decl.id.start, "Binding " + decl.id.name + " in strict mode")
    if (this.eat(oatt._accessors)) {
      decl.accessors = {}
      if (this.eat(tt.parenL)) {
        if (!this.eat(tt.parenR)) {
          for (;;) {
            let config = this.parseIdent(true)
            switch (config.name) {
            case "property":
            case "getter":
              this.expect(tt.eq, "Expected '=' after 'getter' accessor attribute")
              decl.accessors[config.name] = this.parseIdent(true)
              break

            case "setter":
              this.expect(tt.eq, "Expected '=' after 'setter' accessor attribute")
              let setter = this.parseIdent(true)
              decl.accessors[config.name] = setter
              if (this.eat(tt.colon))
                setter.end = this.start
              setter.name += ":"
              break

            case "readwrite":
            case "readonly":
            case "copy":
              decl.accessors[config.name] = true
              break

            default:
              this.raise(config.start, "Unknown accessors attribute '" + config.name + "'")
            }
            if (!this.eat(tt.comma)) break
          }
          this.expect(tt.parenR, "Expected closing ')' after accessor attributes")
        }
      }
    }
    this.finishNode(decl, "IvarDeclaration")
    node.ivardeclarations.push(decl)
    if (!this.eat(tt._comma)) break
  }
  this.semicolon()
}

pp.parseObjjClassElement = function() {
  let element = this.startNode()
  if (this.value === "+" || this.value === "-") {
    this.parseObjjMethodDeclaration(element)
    this.eat(tt.semi)
    element.startOfBody = this.lastTokEnd
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    let oldInFunc = this.objjInFunction, oldLabels = this.objjLabels, oldAsync = this.objjFunctionIsAsync
    this.objjInFunction = true; this.objjLabels = []
    this.objjFunctionIsAsync = !!element.returntype && !!element.returntype.async
    this.enterScope(functionFlags(this.objjFunctionIsAsync, false))
    element.body = this.parseBlock(true)
    this.exitScope()
    this.objjInFunction = oldInFunc; this.objjLabels = oldLabels; this.objjFunctionIsAsync = oldAsync
    return this.finishNode(element, "MethodDeclarationStatement")
  } else
    return this.parseStatement()
}

// Parse the next token as an Objective-J typ.
// It can start with 'async' for return types of a method
// It can be 'id' followed by a optional protocol '<CPKeyValueBinding, ...>'
// It can be 'void' or 'id'
// It can be 'signed' or 'unsigned' followed by an optional 'char', 'byte', 'short', 'int' or 'long'
// It can be 'char', 'byte', 'short', 'int' or 'long'
// 'int' can be followed by an optinal 'long'. 'long' can be followed by an optional extra 'long'

pp.parseObjectiveJType = function(startFrom, canBeAsync) {
  let node = startFrom ? this.startNodeFrom(startFrom) : this.startNode(), allowProtocol = false
  if (canBeAsync && this.options.ecmaVersion >= 8 && this.eatContextual("async")) {
    node.async = true
  }
  if (this.type === tt.name) {
    // It should be a class name
    node.name = this.value
    node.typeisclass = true
    allowProtocol = true
    this.next()
  } else {
    node.typeisclass = false
    node.name = this.type.keyword
    // Do nothing more if it is 'void'
    if (!this.eat(tt._void)) {
      if (this.eat(ott._id)) {
        allowProtocol = true
      } else {
        // Now check if it is some basic type or an approved combination of basic types
        let nextKeyWord
        if (this.eat(ott._float) || this.eat(ott._boolean) || this.eat(ott._SEL) || this.eat(ott._double)) {
          nextKeyWord = this.type.keyword
        } else {
          if (this.eat(ott._signed) || this.eat(ott._unsigned))
            nextKeyWord = this.type.keyword || true
          if (this.eat(ott._char) || this.eat(ott._byte) || this.eat(ott._short)) {
            if (nextKeyWord)
              node.name += " " + nextKeyWord
            nextKeyWord = this.type.keyword || true
          } else {
            if (this.eat(ott._int)) {
              if (nextKeyWord)
                node.name += " " + nextKeyWord
              nextKeyWord = this.type.keyword || true
            }
            if (this.eat(ott._long)) {
              if (nextKeyWord)
                node.name += " " + nextKeyWord
              nextKeyWord = this.type.keyword || true
              if (this.eat(ott._long)) {
                node.name += " " + nextKeyWord
              }
            }
          }
          if (!nextKeyWord) {
            // It must be a class name if it was not a basic type. // FIXME: This is not true
            node.name = (!this.options.forbidReserved && this.type.label) || this.unexpected()
            node.typeisclass = true
            allowProtocol = true
            this.next()
          }
        }
      }
    }
  }
  if (allowProtocol) {
    // Is it 'id' or classname followed by a '<' then parse protocols.
    if (this.value === "<") {
      let first = true,
          protocols = []
      node.protocols = protocols
      do {
        this.next()
        if (first)
          first = false
        else
          this.eat(tt.comma)
        protocols.push(this.parseIdent(true))
      } while (this.value !== ">")
      this.next()
    }
  }
  return this.finishNode(node, "ObjectiveJType")
}

pp.parseObjjPreprocess = function(node) {
  this.next()
  return this.finishNode(node, "PreprocessStatement")
}

pp.parseObjjClass = function(node) {
  this.next()
  node.id = this.parseIdent(false)
  return this.finishNode(node, "ClassStatement")
}

pp.parseObjjGlobal = function(node) {
  this.next()
  node.id = this.parseIdent(false)
  return this.finishNode(node, "GlobalStatement")
}

pp.parseObjjTypedef = function(node) {
  this.next()
  node.typedefname = this.parseIdent(true)
  return this.finishNode(node, "TypeDefStatement")
}

// Parses a comma-separated list of <key>:<value> pairs and returns them as
// [arrayOfKeyExpressions, arrayOfValueExpressions].
pp.parseObjjDictionary = function() {
  this.expect(tt.braceL, "Expected '{' before dictionary")

  let keys = [], values = [], first = true
  while (!this.eat(tt.braceR)) {
    if (!first) {
      this.expect(tt.comma, "Expected ',' between expressions")
      if (/* this.options.allowTrailingCommas && */ this.eat(tt.braceR)) break
    }

    keys.push(this.parseExpression(true, null, true, true))
    this.expect(tt.colon, "Expected ':' between dictionary key and value")
    values.push(this.parseExpression(true, null, true, true))
    first = false
  }
  return [keys, values]
}

pp.parseObjjSelector = function(node, close) {
  let first = true,
      selectors = []
  for (;;) {
    if (this.type !== tt.colon) {
      selectors.push(this.parseIdent(true).name)
      if (first && this.type === close) break
    }
    this.expect(tt.colon, "Expected ':' in selector")
    selectors.push(":")
    if (this.type === close) break
    first = false
  }
  node.selector = selectors.join("")
}

pp.parseObjjMessageSendExpression = function(node, firstExpr) {
  this.parseObjjSelectorWithArguments(node, tt.bracketR)
  if (firstExpr.type === "Identifier" && firstExpr.name === "super")
    node.superObject = true
  else
    node.object = firstExpr
  return this.finishNode(node, "MessageSendExpression")
}

pp.parseObjjSelectorWithArguments = function(node, close) {
  let first = true,
      selectors = [],
      args = []
  node.selectors = selectors
  node.arguments = args
  for (;;) {
    // Special case if 'in' is an identifier. TODO: Ugly fix.
    if (this.type !== tt.colon || (this.inIsIdentifier && this.type === tt.colon)) {
      if (this.inIsIdentifier) {
        let inNode = this.finishNode(this.startNode(), "Identifier")
        inNode.name = "in"
        selectors.push(inNode)
        this.inIsIdentifier = false
      } else {
        selectors.push(this.parseIdent(true))
      }
      if (first && this.eat(close))
        break
    } else {
      selectors.push(null)
    }
    this.expect(tt.colon, "Expected ':' in selector")
    args.push(this.parseExpression(true, null, true, true))
    if (this.eat(close))
      break
    if (this.type === tt.comma) {
      node.parameters = []
      while (this.eat(tt.comma)) {
        node.parameters.push(this.parseExpression(true, null, true, true))
      }
      this.eat(close)
      break
    }
    first = false
  }
}
