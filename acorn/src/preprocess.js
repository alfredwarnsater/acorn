import {types as tt, keywords} from "./tokentype.js"
import {Parser} from "./state.js"
import {isIdentifierStart, nonASCIIidentifierStart} from "./identifier.js"
import {nonASCIIwhitespace, lineBreak} from "./whitespace.js"

const pp = Parser.prototype

// import {getTokenFromCode} from "./tokenize.js"

// ident is the identifier name for the macro
// macro is the macro string
// parameters is an array with the parameters for the macro
// start is the offset to where the macro is defined
// isArgument is true if the macro is a parameter
// parameterScope is the parameter scope
// varadicName is the name of the varadic parameter if it is a varadic macro
// locationOffset is the current line that the macro starts at and the position on the line

export class PositionOffset {
  constructor(line, column, preprocessStackLastItem) {
    this.line = line - 1 // Line start on one so we have to convert it to an offset
    this.column = column
    if (preprocessStackLastItem) {
      let macro = preprocessStackLastItem.macro
      let locationOffset = macro.locationOffset
      if (locationOffset) {
        let macroCurrentLine = locationOffset.line
        if (macroCurrentLine) this.line += macroCurrentLine
        let macroCurrentLineStart = locationOffset.column
        if (macroCurrentLineStart) this.column += macroCurrentLineStart
      }
    }
  }
}

export class Macro {
  constructor(ident, macro, parameters, start, isArgument, parameterScope, variadicName, locationOffset, aSourceFile) {
    this.identifier = ident
    if (macro != null) this.macro = macro
    if (parameters) this.parameters = parameters
    if (start != null) this.start = start
    if (isArgument) this.isArgument = true
    if (parameterScope) this.parameterScope = parameterScope
    if (variadicName) this.variadicName = variadicName
    if (locationOffset) this.locationOffset = locationOffset
    if (aSourceFile) this.sourceFile = aSourceFile
  }

  isParameterFunction() {
    return this.isParameterFunctionVar || (this.isParameterFunctionVar = makePredicate((this.parameters || []).join(" ")))
  }
}

// The preprocessor keywords.
let isKeywordPreprocessor = makePredicate("define undef pragma if ifdef ifndef else elif endif defined error warning include")

// This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.

function makePredicate(words) {
  words = words.split(" ")
  let f = "", cats = []
  out: for (let i = 0; i < words.length; ++i) {
    for (let j = 0; j < cats.length; ++j)
      if (cats[j][0].length === words[i].length) {
        cats[j].push(words[i])
        continue out
      }
    cats.push([words[i]])
  }
  function compareTo(arr) {
    if (arr.length === 1) return f += "return str === " + JSON.stringify(arr[0]) + ";"
    f += "switch(str){"
    for (let i = 0; i < arr.length; ++i) f += "case " + JSON.stringify(arr[i]) + ":"
    f += "return true}return false;"
  }

  // When there are more than three length categories, an outer
  // switch first dispatches on the lengths, to save on comparisons.

  if (cats.length > 3) {
    cats.sort(function(a, b) { return b.length - a.length })
    f += "switch(str.length){"
    for (let i = 0; i < cats.length; ++i) {
      let cat = cats[i]
      f += "case " + cat[0].length + ":"
      compareTo(cat)
    }
    f += "}"

    // Otherwise, simply generate a flat `switch` statement.
  } else {
    compareTo(words)
  }
  return new Function("str", f)
}

pp.preprocesSkipRestOfLine = function() {
  let ch = this.input.charCodeAt(this.pos)
  let last
  // If the last none whitespace character is a '\' the line will continue on the the next line.
  // Here we break the way gcc works as it joins the lines first and then tokenize it. Because of
  // this we can't have a newline in the middle of a word.
  while (this.pos < this.input.length && ((ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) || last === 92)) { // White space and '\'
    if (ch !== 32 && ch !== 9 && ch !== 160 && (ch < 5760 || !nonASCIIwhitespace.test(String.fromCharCode(ch))))
      last = ch
    ch = this.input.charCodeAt(++this.pos)
  }
}

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

// preprocessToken is used to cancel preNotSkipping when calling from readToken_preprocess.
// FIXME: Refactor to not use this parameter preprocessToken. It is kind of confusing and it should be possible to do in another way
pp.preprocessReadToken = function(skipComments, preprocessToken, processMacros, onlyTransformMacroArguments) {
  this.skipSpace(true)
  this.preStart = this.pos
  this.preInput = this.input
  this.preParameterScope = this.preprocessParameterScope
  if (this.pos >= this.input.length) return this.preprocessFinishToken(tt.eof)
  let code = this.input.charCodeAt(this.pos)
  if (!preprocessToken && !this.preNotSkipping && code !== 35) { // '#'
    // If we are skipping take the whole line if the token does not start with '#' (preprocess tokens)
    this.preprocesSkipRestOfLine()
    this.preprocessFinishToken(tt._preprocessSkipLine, this.input.slice(this.preStart, this.pos))
    this.preprocessSkipSpace(true, true) // Don't skip comments and skip EOL
    return
  } else if (this.preprocessMacroParameterListMode && code !== 41 && code !== 44) { // ')', ','
    let parenLevel = 0
    // If we are parsing a macro parameter list parentheses within each argument must balance
    while (this.pos < this.input.length && (parenLevel || (code !== 41 && code !== 44))) { // ')', ','
      if (code === 40) // '('
        parenLevel++
      if (code === 41) // ')'
        parenLevel--
      if (code === 34 || code === 39) { // '"' "'" We have a quote so go all the way to the end of the quote
        let quote = code
        code = this.input.charCodeAt(++this.pos)
        while (this.pos < this.input.length && code !== quote) {
          if (code === 92) { // '\'
            code = this.input.charCodeAt(++this.pos)
            if (code !== quote) continue
          }
          code = this.input.charCodeAt(++this.pos)
        }
      }
      code = this.input.charCodeAt(++this.pos)
    }
    return this.preprocessFinishToken(tt._preprocessParamItem, this.input.slice(this.preStart, this.pos))
  }
  if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || (code === 92 /* '\' */ && this.input.charCodeAt(this.pos + 1) === 117 /* 'u' */)) return this.preprocessReadWord(processMacros)
  if (this.getTokenFromCode(code, skipComments ? preprocessFinishTokenSkipComments : this.preprocessFinishToken, true) === false) { // Allow _eol token
    // If we are here, we either found a non-ASCII identifier
    // character, or something that's entirely disallowed.
    let ch = String.fromCharCode(code)
    if (ch === "\\" || nonASCIIidentifierStart.test(ch)) return this.preprocessReadWord(processMacros)
    this.raise(this.pos, "Unexpected character '" + ch + "'")
  }
}

pp.preprocessReadWord = function(processMacros, onlyTransformMacroArguments) {
  let word = this.readWord1()
  let type = tt.name
  let readMacroWordReturn
  if (processMacros && this.options.preprocess) {
    readMacroWordReturn = readMacroWord(word, pp.preprocessNext, onlyTransformMacroArguments)
    if (readMacroWordReturn === true)
      return true
  }

  if (!this.containsEsc && isKeywordPreprocessor(word)) type = keywords[word]
  this.preprocessFinishToken(type, word, readMacroWordReturn, false, processMacros) // If readMacroWord returns anything except 'true' it is the real tokEndPos
}

// If the word is a macro return true as the token is already finished. If not just return 'undefined'.

function readMacroWord(word, nextFinisher, onlyTransformArguments, forceRegexp) {
  let macro,
      lastStackItem = this.preprocessStackLastItem,
      oldParameterScope = this.preprocessParameterScope
  if (lastStackItem) {
    let scope = this.preTokParameterScope || this.preprocessStackLastItem
    // If the current macro has parameters check if this word is one of them and should be translated
    if (scope.parameterDict && scope.macro.isParameterFunction()(word)) {
      macro = scope.parameterDict[word]
      // If it is a variadic macro and we can't find anything in the variadic parameter just get next token
      if (!macro && scope.macro.variadicName === word) {
        // Don't do this if we are stringifying or concatenating as we then want an empty string
        if (this.preConcatenating) {
          this.finishToken(tt.name, "")
          return true
        } else {
          this.skipSpace()
          nextFinisher(true, onlyTransformArguments, forceRegexp, true) // Stealth and Preprocess macros.
        }
        return true
      }
      // Lets look ahead to find out if we find a '##' for token concatenate
      // We don't want to prescan spaces across macro boundary as the macro stack will fall apart
      // So we do a special prescan if we have to cross a boundary all in the name of speed
      if (this.skipSpace(true, true) === true) { // don't skip EOL and don't skip macro boundary.
        if (preprocessPrescanFor(35, 35)) // Prescan across boundary for '##' as we crossed a boundary
          onlyTransformArguments = 2
      } else if (this.input.charCodeAt(this.pos) === 35 && this.input.charCodeAt(this.pos + 1) === 35) { // '##'
        onlyTransformArguments = 2
      }
      this.preprocessParameterScope = macro && macro.parameterScope
      onlyTransformArguments--
    }
  }

  // Does the word match against any of the known macro names
  // Don't match if:
  //   1. We already has found a argument macro
  //   2. We are doing concatenating. Here it is only valid for the last token.
  if (!macro && (!onlyTransformArguments && !this.preprocessOnlyTransformArgumentsForLastToken || this.pos < this.input.length) && this.options.preprocessIsMacro(word)) {
    this.preprocessParameterScope = null
    macro = this.options.preprocessGetMacro(word)
    if (macro) {
      // Check if this macro is already referenced by looking in the stack
      // Don't do it if the input in the stack is an argument. We want to simulate 'expand arguments first'
      if (!this.preprocessStackLastItem || !this.preprocessStackLastItem.macro.isArgument) {
        let i = this.preprocessStack.length,
            lastMacroItem
        while (i > 0) {
          let item = this.preprocessStack[--i],
              macroItem = item.macro
          if (macroItem.identifier === word && !(lastMacroItem && lastMacroItem.isArgument)) {
            macro = null
          }
          lastMacroItem = macroItem
        }
      }
    } else {
      macro = preprocessBuiltinMacro(word)
    }
  }
  if (macro) {
    let parameters
    let hasParameters = macro.parameters
    let nextIsParenL
    if (hasParameters) {
      // Ok, we should have parameters for the macro. Lets look ahead to find out if we find a '('
      // First save current position and loc for tokEndPos
      let pos = this.pos
      // let loc
      // if (this.options.locations) loc = new line_loc_t
      if ((this.skipSpace(true, true) === true && preprocessPrescanFor(40)) || this.input.charCodeAt(this.pos) === 40) { // '('
        nextIsParenL = true
      } else {
        // We didn't find a '(' so don't transform to the macro. Return the real tokEndPos so we get correct token end values.
        // preprocessOverrideTokEndLoc = loc
        return pos
      }
    }
    if (!hasParameters || nextIsParenL) {
      // Now we know that we have a matching macro. Get parameters if needed
      if (nextIsParenL) {
        let variadicName = macro.variadicName
        let first = true
        let noParams = 0
        parameters = Object.create(null)
        this.skipSpace(true)
        // preprocessReadToken();
        // preprocessMacroParameterListMode = true;
        // preprocessExpect(_parenL);
        // lastTokPos = tokPos;
        if (this.input.charCodeAt(this.pos++) !== 40) this.raise(this.pos - 1, "Expected '(' before macro prarameters")
        this.skipSpace(true, true, true)
        let code = this.input.charCodeAt(this.pos++)
        while (this.pos < this.input.length && code !== 41) {
          if (first)
            first = false
          else
          if (code === 44) { // ','
            this.skipSpace(true, true, true)
            code = this.input.charCodeAt(this.pos++)
          } else
            this.raise(this.pos - 1, "Expected ',' between macro parameters")
          let ident = hasParameters[noParams++]
          let variadicAndLastParameter = variadicName && hasParameters.length === noParams
          let paramStart = this.pos - 1, parenLevel = 0
          // Calculate current line and current line start.
          let positionOffset = this.options.locations && new PositionOffset(this.curLine, this.tokLineStart)
          // When parsing a macro parameter list parentheses within each argument must balance
          // If it is variadic and we are on the last paramter collect all the rest of the parameters
          while (this.pos < this.input.length && (parenLevel || (code !== 41 && (code !== 44 || variadicAndLastParameter)))) { // ')', ','
            if (code === 40) // '('
              parenLevel++
            if (code === 41) // ')'
              parenLevel--
            if (code === 34 || code === 39) { // '"' "'" We have a quote so go all the way to the end of the quote
              let quote = code
              code = this.input.charCodeAt(this.pos++)
              while (this.pos < this.input.length && code !== quote) {
                if (code === 92) { // '\'
                  code = this.input.charCodeAt(this.pos++)
                  if (code !== quote) continue
                }
                code = this.input.charCodeAt(this.pos++)
              }
            }
            code = this.input.charCodeAt(this.pos++)
          }
          let val = this.input.slice(paramStart, this.pos - 1)
          // var val = preTokType === _preprocessParamItem ? preTokVal : "";
          parameters[ident] = new Macro(ident, val, null, paramStart + this.tokMacroOffset, true, this.preTokParameterScope || this.preprocessStackLastItem, false, positionOffset) // true = 'Is argument', false = 'Not varadic'
        }
        if (code !== 41) this.raise(this.pos, "Expected ')' after macro prarameters")
        this.skipSpace(true, true) // Don't skip EOL and don't skip macro boundary
        // preprocessMacroParameterListMode = false;
        // preprocessExpect(_parenR);
      }
      // If the macro defines anything add it to the preprocess input stack
      return readTokenFromMacro(macro, this.tokPosMacroOffset, parameters, oldParameterScope, this.pos, nextFinisher, onlyTransformArguments, forceRegexp)
    }
  }
}

// Here we pre scan for first and second character.
// The first thing should be to skip spaces and comments
// Return true if the first characters after spaces are first and second
// This is very simular to the function onlySkipSpace. Maybe the same
// function can be used with some refactoring?
function preprocessPrescanFor(first, second) {
  let i = this.preprocessStack.length

  let scanInput
  let scanPos
  stackloop:
  while (i-- > 0) {
    let stackItem = this.preprocessStack[i]
    let scanInputLen = stackItem.inputLen
    scanPos = stackItem.end
    scanInput = stackItem.input

    for (;;) {
      let ch = scanInput.charCodeAt(scanPos)
      if (ch === 32) { // ' '
        ++scanPos
      } else if (ch === 13) {
        ++scanPos
        let next = scanInput.charCodeAt(scanPos)
        if (next === 10) {
          ++scanPos
        }
      } else if (ch === 10) {
        ++scanPos
      } else if (ch === 9) {
        ++scanPos
      } else if (ch === 47) { // '/'
        let next = scanInput.charCodeAt(scanPos + 1)
        if (next === 42) { // '*'
          let end = scanInput.indexOf("*/", scanPos += 2)
          if (end === -1) this.raise(scanPos - 2, "Unterminated comment")
          scanPos = end + 2
        } else if (next === 47) { // '/'
          ch = scanInput.charCodeAt(scanPos += 2)
          while (scanPos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
            ++scanPos
            ch = scanInput.charCodeAt(scanPos)
          }
        } else break stackloop
      } else if (ch === 160 || ch === 11 || ch === 12 || (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch)))) { // '\xa0', VT, FF, Unicode whitespaces
        ++scanPos
      } else if (scanPos >= scanInputLen) {
        continue stackloop
      } else if (ch === 92) { // '\'
        // Check if we have an escaped newline. We are using a relaxed treatment of escaped newlines like gcc.
        // We allow spaces, horizontal and vertical tabs, and form feeds between the backslash and the subsequent newline
        let pos = scanPos + 1
        ch = scanInput.charCodeAt(pos)
        while (pos < scanInputLen && (ch === 32 || ch === 9 || ch === 11 || ch === 12 || (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))))) // nonASCIIwhitespaceNoNewLine before
          ch = scanInput.charCodeAt(++pos)
        lineBreak.lastIndex = 0
        let match = lineBreak.exec(scanInput.slice(pos, pos + 2))
        if (match && match.index === 0) {
          scanPos = pos + match[0].length
        } else {
          break stackloop
        }
      } else {
        break stackloop
      }
    }
  }
  return scanInput && scanInput.charCodeAt(scanPos) === first && (second == null || scanInput.charCodeAt(scanPos + 1) === second)
}

// Push macro to stack and start read from it.
// Just read next token if the macro is empty
function readTokenFromMacro(macro, macroOffset, parameters, parameterScope, end, nextFinisher, onlyTransformArguments, forceRegexp) {
  let macroString = macro.macro
  // If we are evaluation a macro expresion an empty macro definition means true or '1'
  if (!macroString && nextFinisher === this.preprocessNext) macroString = "1"
  if (macroString) {
    this.pushMacroToStack(macro, macroString, macroOffset, parameters, parameterScope, end, onlyTransformArguments)
  } else if (this.preConcatenating) {
    // If we are concatenating or stringifying and the macro is empty just make an empty string.
    (nextFinisher === this.next ? this.finishToken : this.preprocessFinishToken)(tt.name, "")
    return true
  }
  // Now read the next token
  this.skipSpace()
  nextFinisher(true, onlyTransformArguments, forceRegexp, true) // Stealth and Preprocess macros
  return true
}

let macrosMakeBuiltin = function(name, macro, endPos) { return new Macro(name, macro, null, endPos - name.length) }

export const macrosBuiltinMacros = {
  __OBJJ__: function(parser) { return macrosMakeBuiltin("__OBJJ__", parser.options.objj ? "1" : null, parser.pos) }
}

macrosBuiltinMacros["__" + "BROWSER" + "__"] = function(parser) { return macrosMakeBuiltin("__BROWSER__", (typeof window) !== "undefined" ? "1" : null, parser.pos) }
macrosBuiltinMacros["__" + "LINE" + "__"] = function(parser) { return macrosMakeBuiltin("__LINE__", String(parser.options.locations ? parser.curLine : parser.getLineInfo(parser.input, parser.pos).line), parser.pos) }
macrosBuiltinMacros["__" + "DATE" + "__"] = function(parser) { let date, day; return macrosMakeBuiltin("__DATE__", (date = new Date(), day = String(date.getDate()), ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()] + (day.length > 1 ? " " : "  ") + day + " " + date.getFullYear()), parser.pos) }
macrosBuiltinMacros["__" + "TIME" + "__"] = function(parser) { let date; return macrosMakeBuiltin("__TIME__", (date = new Date(), ("0" + date.getHours()).slice(-2) + ":" + ("0" + date.getMinutes()).slice(-2) + ":" + ("0" + date.getSeconds()).slice(-2)), parser.pos) }

function preprocessBuiltinMacro(macroIdentifier) {
  let builtinMacro = macrosBuiltinMacros[macroIdentifier]
  return builtinMacro ? builtinMacro() : null
}

// Push macro to stack and reset tokPos etc.
// macroString is the string from the macro. It is usually 'macro.macro' but the caller can modify it if needed
// includeFile is true if the macro should be treated as a regular file. In other words don't stringify words after '#'
pp.pushMacroToStack = function(macro, macroString, macroOffset, parameters, parameterScope, end, onlyTransformArguments, isIncludeFile) {
  this.preprocessStackLastItem = {macro: macro, macroOffset: macroOffset, parameterDict: parameters, /* start: macroStart, */ end: end, lastEnd: this.localLastEnd, inputLen: this.input.length, tokStart: this.start, onlyTransformArgumentsForLastToken: this.preprocessOnlyTransformArgumentsForLastToken, currentLine: this.curLine, currentLineStart: this.line, sourceFile: this.sourceFile}
  if (parameterScope) this.preprocessStackLastItem.parameterScope = parameterScope
  if (isIncludeFile) this.preprocessStackLastItem.isIncludeFile = isIncludeFile
  this.preprocessStackLastItem.input = this.input
  this.preprocessStack.push(this.preprocessStackLastItem)
  this.preprocessOnlyTransformArgumentsForLastToken = onlyTransformArguments
  this.input = macroString
  this.input.length = macroString.length
  this.tokPosMacroOffset = macro.start
  this.pos = 0
  this.curLine = 1
  this.lineStart = 0
  this.firstTokEnd = 0
  this.localLastEnd = 0
  if (macro.sourceFile) this.sourceFile = macro.sourceFile
}
// FIXME: Find out if this is really used?
function preprocessFinishTokenSkipComments(type, val) {
  this.preType = type
  this.preVal = val
  this.firstTokEnd = this.preEnd = this.pos
  this.preprocessSkipSpace(true) // 'true' for don't skip comments
}

// Continue to the next token.

pp.preprocessNext = function(stealth, onlyTransformArguments, forceRegexp, processMacros) {
  if (!stealth) {
    this.preLastStart = this.preStart
    this.preLastEnd = this.preEnd
  }
  this.localLastEnd = this.firstTokEnd
  return this.preprocessReadToken(false, false, processMacros, onlyTransformArguments)
}

// Skip whitespaces sometimes without line breaks
// Returns true if it stops at a line break.

pp.preprocessSkipSpace = function(dontSkipComments, skipEOL) {
  let ch = this.skipSpace(!skipEOL, false, dontSkipComments)
  // Can't see that this line break test is used anymore
  // lineBreak.lastIndex = 0;
  // var match = lineBreak.exec(input.slice(tokPos, tokPos + 2));
  // return (match && match.index === 0);
  return ch
}

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

pp.preprocessEat = function(type, processMacros) {
  if (this.preType === type) {
    this.preprocessNext(false, false, null, processMacros)
    return true
  }
}

// Expect a token of a given type. If found, consume it, otherwise,
// this.raise with errorMessage or an unexpected token error.

pp.preprocessExpect = function(type, errorMessage, processMacros) {
  if (this.preType === type) this.preprocessNext(false, undefined, null, processMacros)
  else this.raise(this.preStart, errorMessage || "Unexpected token")
}

function debug() {
  // debugger;
}
pp.preprocessGetIdent = function(processMacros) {
  let ident = this.preType === tt.name ? this.preVal : ((!this.options.forbidReserved || this.preType.okAsIdent) && this.preType.keyword) || debug() // this.raise(this.preStart, "Expected Macro identifier");
  // tokRegexpAllowed = false;
  this.preprocessNext(false, false, null, processMacros)
  return ident
}

pp.preprocessFinishToken = function(type, val, overrideTokEnd, skipEOL, processMacros) {
  this.preType = type
  this.preVal = val
  this.preEnd = overrideTokEnd || this.pos
  if (type !== tt.eol) this.firstEnd = this.preEnd
  // tokRegexpAllowed = type.beforeExpr;
  let ch = this.preprocessSkipSpace(false, skipEOL) // Skip comments
  if (ch === 35 && this.options.preprocess && !this.preprocessDontConcatenate && this.input.charCodeAt(this.pos + 1) === 35) { // '##'
    let val1 = val != null ? val : type.keyword || type.type
    this.pos += 2
    if (val1 != null) {
      // Save current line and current line start. This is needed when option.locations is true
      let positionOffset = this.options.locations && new PositionOffset(this.curLine, this.lineStart, this.preprocessStackLastItem)
      // Save positions on first token to get start and end correct on node if cancatenated token is invalid
      let saveTokInput = this.input, saveTokEnd = this.preEnd, saveTokStart = this.preStart, start = this.preStart + this.tokMacroOffset, variadicName = this.preprocessStackLastItem && this.preprocessStackLastItem.macro && this.preprocessStackLastItem.macro.variadicName
      this.skipSpace()
      let isVariadic = null
      if (variadicName && variadicName === this.input.slice(this.pos, this.pos + variadicName.length)) {
        isVariadic = true
      }
      this.preConcatenating = true
      this.preprocessReadToken(null, null, processMacros, 2) // 2 = Don't transform macros only arguments
      this.preConcatenating = false
      let val2 = this.preVal != null ? this.preVal : this.preType.keyword || this.preType.type
      if (val2 != null) {
        // Skip token if it is a ',' concatenated with an empty variadic parameter
        if (isVariadic && val1 === "," && val2 === "") return this.preprocessReadToken()
        let concat = "" + val1 + val2, val2TokStart = this.preStart + this.tokPosMacroOffset
        // If the macro defines anything add it to the preprocess input stack
        let concatMacro = new Macro(null, concat, null, start, false, null, false, positionOffset)
        let r = readTokenFromMacro(concatMacro, this.tokPosMacroOffset, this.preprocessStackLastItem ? this.preprocessStackLastItem.parameterDict : null, null, this.pos, this.preprocessNext, null)
        // Consumed the whole macro in one bite? If not the tokenizer can't create a single token from the two concatenated tokens
        if (this.preprocessStackLastItem && this.preprocessStackLastItem.macro === concatMacro) {
          // FIXME: Should change this to 'preType' and friends
          this.preType = type
          this.preStart = saveTokStart
          this.preEnd = saveTokEnd
          this.input = saveTokInput
          this.tokPosMacroOffset = val2TokStart - val1.length // reset the macro offset to the second token to get start and end correct on node
          if (!isVariadic) /* this.raise(tokStart, */console.log("Warning: pasting formed '" + concat + "', an invalid preprocessing token")
        } else return r
      }
    }
  }
}
