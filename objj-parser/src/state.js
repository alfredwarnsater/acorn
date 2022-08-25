import {reservedWords, keywords} from "./identifier.js"
import {types as tt} from "./tokentype.js"
import {lineBreak} from "./whitespace.js"
import {getOptions} from "./options.js"
import {wordsRegexp} from "./util.js"
import {SCOPE_TOP, SCOPE_FUNCTION, SCOPE_ASYNC, SCOPE_GENERATOR, SCOPE_SUPER, SCOPE_DIRECT_SUPER, SCOPE_CLASS_STATIC_BLOCK} from "./scopeflags.js"
import {Macro} from "./preprocess-macro.js"
import {getLineInfo} from "./locutil.js"

export class Parser {
  constructor(options, input, startPos) {
    this.options = options = getOptions(options)
    this.sourceFile = options.sourceFile
    this.keywords = wordsRegexp(keywords[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5])
    let reserved = ""
    if (options.allowReserved !== true) {
      reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3]
      if (options.sourceType === "module") reserved += " await"
    }
    this.reservedWords = wordsRegexp(reserved)
    let reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict
    this.reservedWordsStrict = wordsRegexp(reservedStrict)
    this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind)
    this.input = String(input)

    // Used to signal to callers of `readWord1` whether the word
    // contained any escape sequences. This is needed because words with
    // escape sequences must not be interpreted as keywords.
    this.containsEsc = false

    // Set up token state

    // The current position of the tokenizer in the input.
    if (startPos) {
      this.pos = startPos
      this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1
      this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length
    } else {
      this.pos = this.lineStart = 0
      this.curLine = 1
    }

    // Properties of the current token:
    // Its type
    this.type = tt.eof
    // For tokens that include more information than their type, the value
    this.value = null
    // Its start and end offset
    this.start = this.end = this.pos
    // And, if locations are used, the {line, column} object
    // corresponding to those offsets
    this.startLoc = this.endLoc = this.curPosition()

    // Position information for the previous token
    this.lastTokEndLoc = this.lastTokStartLoc = null
    this.lastTokStart = this.lastTokEnd = this.pos

    // The context stack is used to superficially track syntactic
    // context to predict whether a regular expression is allowed in a
    // given position.
    this.context = this.initialContext()
    this.exprAllowed = true

    // Figure out if it's a module code.
    this.inModule = options.sourceType === "module"
    this.strict = this.inModule || this.strictDirective(this.pos)

    // Used to signify the start of a potential arrow function
    this.potentialArrowAt = -1
    this.potentialArrowInForAwait = false

    // Positions to delayed-check that yield/await does not exist in default parameters.
    this.yieldPos = this.awaitPos = this.awaitIdentPos = 0
    // Labels in scope.
    this.labels = []
    // Thus-far undefined exports.
    this.undefinedExports = Object.create(null)

    // If enabled, skip leading hashbang line.
    if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!")
      this.skipLineComment(2)

    // Scope tracking for duplicate variable names (see scope.js)
    this.scopeStack = []
    this.enterScope(SCOPE_TOP)

    // For RegExp validation
    this.regexpState = null

    // The stack of private names.
    // Each element has two properties: 'declared' and 'used'.
    // When it exited from the outermost class definition, all used private names must be declared.
    this.privateNameStack = []

    // These are used by the preprocess tokenizer.
    this.preprocessParameterScope = null
    this.preTokParameterScope = null
    this.preprocessMacroParameterListMode = false
    this.preprocessIsParsingPreprocess = false
    this.preprocessStack = []
    this.preprocessStackLastItem = null
    this.preprocessOnlyTransformArgumentsForLastToken = null
    this.preprocessDontConcatenate = false
    this.preNotSkipping = true
    this.preConcatenating = false
    this.preIfLevel = []

    this.preType = null
    this.preVal = null
    this.preStart = null
    this.preEnd = null

    this.preLastStart = null
    this.preLastEnd = null

    this.localLastEnd = null
    this.firstEnd = null

    this.preInput = null

    // This is the parser's state. `inFunction` is used to reject
    // `return` statements outside of functions, `labels` to verify that
    // `break` and `continue` have somewhere to jump to, `functionIsAsync`
    // to know if await is a identifier or a keyword and `strict`
    // indicates whether strict mode is on.

    this.objjInFunction = null
    this.objjLabels = null
    this.objjFunctionIsAsync = null
    this.objjStrict = null

    this.nodeMessageSendObjectExpression = null

    // The start and end offsets of the current token.
    // First tokstart is the same as tokStart except when the preprocessor finds a macro.
    // Then the tokFirstStart points to the start of the token that will be replaced by the macro.
    // tokStart then points at the macros first
    // tokMacroOffset is the offset to the current macro for the current token
    // tokPosMacroOffset is the offset to the current macro for the current tokPos

    this.tokFirstStart = null
    this.firstTokEnd = null
    this.tokMacroOffset = null
    this.tokPosMacroOffset = null
    this.lastTokMacroOffset = null

    function macrosMakeBuiltin(name, macro, endPos) { return new Macro(name, macro, null, endPos - name.length) }

    if (this.options.preprocess) {
      let self = this
      let macros = Object.create(null)
      let macrosIsRegEx
      if (this.options.preprocessAddMacro == null) {
        this.options.preprocessAddMacro = function(macro) {
          macros[macro.identifier] = macro
          macrosIsRegEx = null
        }
      }
      if (this.options.preprocessGetMacro == null) {
        this.options.preprocessGetMacro = function(macroIdentifier) {
          return macros[macroIdentifier]
        }
      }
      if (this.options.preprocessUndefineMacro == null) {
        this.options.preprocessUndefineMacro = function defaultUndefineMacro(macroIdentifier) {
          delete macros[macroIdentifier]
          macrosIsRegEx = null
        }
      }
      if (this.options.preprocessIsMacro == null) {
        this.options.preprocessIsMacro = function(macroIdentifier) {
          return (macrosIsRegEx || (macrosIsRegEx = wordsRegexp(Object.keys(macros).concat(Object.keys(self.macrosBuiltinMacros).filter(function(key) { return this[key]().macro != null }, self.macrosBuiltinMacros)).join(" ")))).test(macroIdentifier)
        }
      }
      this.macrosBuiltinMacros = {
        __OBJJ__: function() { return macrosMakeBuiltin("__OBJJ__", self.options.objj ? "1" : null, self.pos) }
      }

      this.macrosBuiltinMacros["__" + "BROWSER" + "__"] = function() { return macrosMakeBuiltin("__BROWSER__", (typeof window) !== "undefined" ? "1" : null, self.pos) }
      this.macrosBuiltinMacros["__" + "LINE" + "__"] = function() { return macrosMakeBuiltin("__LINE__", String(self.options.locations ? self.curLine : getLineInfo(self.input, self.pos).line), self.pos) }
      this.macrosBuiltinMacros["__" + "DATE" + "__"] = function() { let date, day; return macrosMakeBuiltin("__DATE__", (date = new Date(), day = String(date.getDate()), ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()] + (day.length > 1 ? " " : "  ") + day + " " + date.getFullYear()), self.pos) }
      this.macrosBuiltinMacros["__" + "TIME" + "__"] = function() { let date; return macrosMakeBuiltin("__TIME__", (date = new Date(), ("0" + date.getHours()).slice(-2) + ":" + ("0" + date.getMinutes()).slice(-2) + ":" + ("0" + date.getSeconds()).slice(-2)), self.pos) }

      if (this.options.macros)
        this.defineMacros(this.options.macros)

      let preIncludeFiles = this.options.preIncludeFiles
      if (preIncludeFiles && preIncludeFiles.length) for (let i = preIncludeFiles.length - 1; i >= 0; i--) {
        let preIncludeFile = preIncludeFiles[i]

        let preIncludeMacro = new Macro(null, preIncludeFile.include, null, 0, false, null, false, null, preIncludeFile.sourceFile)
        this.pushMacroToStack(preIncludeMacro, preIncludeMacro.macro, 0, null, null, this.pos, null, true) // isIncludeFile
        this.skipSpace()
      }
    }
  }

  parse() {
    let node = this.options.program || this.startNode()
    this.nextToken()
    return this.parseTopLevel(node)
  }

  get inFunction() { return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0 }

  get inGenerator() { return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0 && !this.currentVarScope().inClassFieldInit }

  get inAsync() { return (this.currentVarScope().flags & SCOPE_ASYNC) > 0 && !this.currentVarScope().inClassFieldInit }

  get canAwait() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      let scope = this.scopeStack[i]
      if (scope.inClassFieldInit || scope.flags & SCOPE_CLASS_STATIC_BLOCK) return false
      if (scope.flags & SCOPE_FUNCTION) return (scope.flags & SCOPE_ASYNC) > 0
    }
    return (this.inModule && this.options.ecmaVersion >= 13) || this.options.allowAwaitOutsideFunction
  }

  get allowSuper() {
    const {flags, inClassFieldInit} = this.currentThisScope()
    return (flags & SCOPE_SUPER) > 0 || inClassFieldInit || this.options.allowSuperOutsideMethod
  }

  get allowDirectSuper() { return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0 }

  get treatFunctionsAsVar() { return this.treatFunctionsAsVarInScope(this.currentScope()) }

  get allowNewDotTarget() {
    const {flags, inClassFieldInit} = this.currentThisScope()
    return (flags & (SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK)) > 0 || inClassFieldInit
  }

  get inClassStaticBlock() {
    return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0
  }

  static extend(...plugins) {
    let cls = this
    for (let i = 0; i < plugins.length; i++) cls = plugins[i](cls)
    return cls
  }

  static parse(input, options) {
    return new this(options, input).parse()
  }

  static parseExpressionAt(input, pos, options) {
    let parser = new this(options, input, pos)
    parser.nextToken()
    return parser.parseExpression()
  }

  static tokenizer(input, options) {
    return new this(options, input)
  }
}