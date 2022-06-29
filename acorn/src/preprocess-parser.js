import {Parser} from "./state.js"
import {types as tt, preTypes as ptt} from "./tokentype.js"
import {PositionOffset} from "./preprocess-tokenizer.js"
import {Macro} from "./preprocess-macro.js"

const pp = Parser.prototype

pp.preprocessParseDefine = function() {
  this.preprocessIsParsingPreprocess = true
  this.preprocessReadToken()

  let macroIdentifierEnd = this.preEnd

  // We don't want to concatenate tokens when creating macros
  this.preprocessDontConcatenate = true

  // Get position offset now as ´tokCurLine´ and ´tokLineStart´ points to next token.
  let positionOffset = this.options.locations && new PositionOffset(this.curLine, this.lineStart, this.preprocessStackLastItem)
  let macroIdentifier = this.preVal // this.preprocessGetIdent();
  // '(' Must follow directly after identifier to be a valid macro with parameters
  let isNextCodeParenL = this.input.charCodeAt(macroIdentifierEnd) === 40 // '('
  this.preprocessExpect(tt.name, "Preprocessor #define expects identifier")
  let parameters
  let variadic
  if (isNextCodeParenL) {
    this.preprocessExpect(tt.parenL)
    parameters = []
    variadic = false
    let first = true
    while (!this.preprocessEat(tt.parenR)) {
      if (variadic) this.raise(this.preStart, "Variadic parameter must be last")
      if (!first) this.preprocessExpect(tt.comma, "Expected ',' between macro parameters"); else first = false
      parameters.push(this.preprocessEat(tt.ellipsis) ? variadic = true && "__VA_ARGS__" : this.preprocessGetIdent())
      if (this.preprocessEat(tt.ellipsis)) variadic = true
      // Get a new position offset as macro has parameters. This is needed if line has escaped (backslash) newline
      positionOffset = this.options.locations && new PositionOffset(this.curLine, this.lineStart, this.preprocessStackLastItem)
    }
  }

  let start = this.preStart

  while (this.preType !== tt.eol && this.preType !== tt.eof)
    this.preprocessReadToken()

  this.preprocessDontConcatenate = false
  let macroString = this.preInput.slice(start, this.preStart)
  macroString = macroString.replace(/\\/g, " ")
  // If variadic get the last parameter for the variadic parameter name
  this.options.preprocessAddMacro(new Macro(macroIdentifier, macroString, parameters, start, false, null, variadic && parameters[parameters.length - 1], positionOffset))
  this.preprocessIsParsingPreprocess = false
}

pp.preprocessSkipToElseOrEndif = function(skipElse) {
  let ifLevel = []
  while (ifLevel.length > 0 || (this.preType !== ptt._preEndif && ((this.preType !== ptt._preElse && this.preType !== ptt._preElseIfTrue) || skipElse))) {
    switch (this.preType) {
    case ptt._preIf:
    case ptt._preIfdef:
    case ptt._preIfndef:
      ifLevel.push(ptt._preIf)
      break

    case ptt._preElse:
      if (ifLevel[ifLevel.length - 1] !== ptt._preIf)
        this.raise(this.preStart, "#else after #else")
      else
        ifLevel[ifLevel.length - 1] = ptt._preElse
      break

    case ptt._preElseIf:
      if (ifLevel[ifLevel.length - 1] !== ptt._preIf)
        this.raise(this.preStart, "#elif after #else")
      break

    case ptt._preEndif:
      ifLevel.pop()
      break

    case tt.eof:
      this.preNotSkipping = true
      this.raise(this.preStart, "Missing #endif")
    }
    this.preprocessReadToken(true)
  }
  this.preNotSkipping = true
  if (this.preType === ptt._preEndif)
    this.preIfLevel.pop()
}

// Parse an  expression — either a single token that is an
// expression, an expression started by a keyword like `defined`,
// or an expression wrapped in punctuation like `()`.
// When `processMacros` is true any macros will we transformed to its definition

pp.preprocessParseExpression = function(processMacros) {
  return this.preprocessParseExprOps(processMacros)
}

// Start the precedence parser.

pp.preprocessParseExprOps = function(processMacros) {
  return this.preprocessParseExprOp(this.preprocessParseMaybeUnary(processMacros), -1, processMacros)
}

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

pp.preprocessParseExprOp = function(left, minPrec, processMacros) {
  let prec = this.preType.binop
  if (prec) {
    if (!this.preType.preprocess) this.raise(this.preStart, "Unsupported macro operator")
    if (prec > minPrec) {
      let node = this.startNodeFrom(left)
      node.left = left
      node.operator = this.preVal
      this.preprocessNext(false, false, false, null, processMacros)
      node.right = this.preprocessParseExprOp(this.preprocessParseMaybeUnary(processMacros), prec, processMacros)
      node = this.preprocessFinishNode(node, /&&|\|\|/.test(node.operator) ? "LogicalExpression" : "BinaryExpression")
      return this.preprocessParseExprOp(node, minPrec, processMacros)
    }
  }
  return left
}

// Parse an unary expression if possible

pp.preprocessParseMaybeUnary = function(processMacros) {
  if (this.preType.preprocess && this.preType.prefix) {
    let node = this.startNode()
    node.operator = this.preVal
    node.prefix = true
    this.preprocessNext(false, false, false, null, processMacros)
    node.argument = this.preprocessParseMaybeUnary(processMacros)
    return this.preprocessFinishNode(node, "UnaryExpression")
  }
  return this.preprocessParseExprAtom(processMacros)
}

// Parse an atomic macro expression — either a single token that is an
// expression, an expression started by a keyword like `defined`,
// or an expression wrapped in punctuation like `()`.

pp.preprocessParseExprAtom = function(processMacros) {
  switch (this.preType) {
  case tt.name:
    return this.preprocessParseIdent(processMacros)

  case tt.num: case tt.string:
    return this.preprocessParseStringNumLiteral(processMacros)

  case tt.parenL:
    let tokStart1 = this.preStart
    this.preprocessNext(false, false, false, null, processMacros)
    let val = this.preprocessParseExpression(processMacros)
    val.start = tokStart1
    val.end = this.preEnd
    this.preprocessExpect(tt.parenR, "Expected closing ')' in macro expression", processMacros)
    return val

  case ptt._preDefined:
    let node = this.startNode()
    this.preprocessNext(false, false, false, null, processMacros)
    node.object = this.preprocessParseDefinedExpression(processMacros)
    return this.preprocessFinishNode(node, "DefinedExpression")

  default:
    this.unexpected()
  }
}

pp.preprocessParseIdent = function(processMacros) {
  let node = this.startNode()
  node.name = this.preprocessGetIdent(processMacros)
  return this.preprocessFinishNode(node, "Identifier")
}

// Parse an 'Defined' macro expression — either a single token that is an
// identifier, number, string or an expression wrapped in punctuation like `()`.

pp.preprocessParseDefinedExpression = function(processMacros) {
  switch (this.preType) {
  case tt.name:
    return this.preprocessParseIdent(processMacros)

  case tt.num: case tt.string:
    return this.preprocessParseStringNumLiteral(processMacros)

  case tt.parenL:
    let tokStart1 = this.preStart
    this.preprocessNext(false, false, false, null, processMacros)
    let val = this.preprocessParseDefinedExpression(processMacros)
    val.start = tokStart1
    val.end = this.preEnd
    this.preprocessExpect(tt.parenR, "Expected closing ')' in macro expression", processMacros)
    return val

  default:
    this.unexpected()
  }
}

pp.preprocessParseStringNumLiteral = function(processMacros) {
  let node = this.startNode()
  node.value = this.preVal
  node.raw = this.preInput.slice(this.preStart, this.preEnd)
  this.preprocessNext(false, false, false, null, processMacros)
  return this.preprocessFinishNode(node, "Literal")
}

pp.preprocessFinishNode = function(node, type) {
  node.type = type
  node.end = this.preEnd
  return node
}

pp.preprocessEvalExpression = function(expr) {
  // A recursive walk is one where your functions override the default
  // walkers. They can modify and replace the state parameter that's
  // threaded through the walk, and can opt how and whether to walk
  // their child nodes (by calling their third argument on these
  // nodes).
  function recursiveWalk(node, state, funcs) {
    let visitor = funcs
    function c(node, st, override) {
      return visitor[override || node.type](node, st, c)
    }
    return c(node, state)
  }
  let self = this
  return recursiveWalk(expr, {}, {
    LogicalExpression: function(node, st, c) {
      let left = node.left, right = node.right
      switch (node.operator) {
      case "||":
        return c(left, st) || c(right, st)
      case "&&":
        return c(left, st) && c(right, st)
      }
    },
    BinaryExpression: function(node, st, c) {
      let left = node.left, right = node.right
      switch (node.operator) {
      case "+":
        return c(left, st) + c(right, st)
      case "-":
        return c(left, st) - c(right, st)
      case "*":
        return c(left, st) * c(right, st)
      case "/":
        return c(left, st) / c(right, st)
      case "%":
        return c(left, st) % c(right, st)
      case "<":
        return c(left, st) < c(right, st)
      case ">":
        return c(left, st) > c(right, st)
      case "^":
        return c(left, st) ^ c(right, st)
      case "&":
        return c(left, st) & c(right, st)
      case "|":
        return c(left, st) | c(right, st)
      case "==":
        return c(left, st) == c(right, st)
      case "===":
        return c(left, st) === c(right, st)
      case "!=":
        return c(left, st) != c(right, st)
      case "!==":
        return c(left, st) !== c(right, st)
      case "<=":
        return c(left, st) <= c(right, st)
      case ">=":
        return c(left, st) >= c(right, st)
      case ">>":
        return c(left, st) >> c(right, st)
      case ">>>":
        return c(left, st) >>> c(right, st)
      case "<<":
        return c(left, st) << c(right, st)
      }
    },
    UnaryExpression: function(node, st, c) {
      let arg = node.argument
      switch (node.operator) {
      case "-":
        return -c(arg, st)
      case "+":
        return +c(arg, st)
      case "!":
        return !c(arg, st)
      case "~":
        return ~c(arg, st)
      }
    },
    Literal: function(node, st, c) {
      return node.value
    },
    Identifier: function(node, st, c) {
      // If it is not macro expanded it should be counted as a zero
      return 0
    },
    DefinedExpression: function(node, st, c) {
      let objectNode = node.object
      if (objectNode.type === "Identifier") {
        // If the macro has parameters it will not expand and we have to check here if it exists
        let name = objectNode.name,
            macro = self.options.preprocessGetMacro(name) || self.preprocessBuiltinMacro(name)
        return macro || 0
      } else {
        return c(objectNode, st)
      }
    }
  })
}
