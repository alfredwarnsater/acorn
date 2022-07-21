import {isIdentifierStart, isIdentifierChar} from "./identifier.js"
import {types as tt, preTypes as ptt, isKeywordPreprocessor, objjTypes as ott, objjAtTypes as oatt, keywords, objjKeywords, objjAtKeywords} from "./tokentype.js"
import {Parser} from "./state.js"
import {SourceLocation} from "./locutil.js"
import {RegExpValidationState} from "./regexp.js"
import {lineBreak, nextLineBreak, isNewLine, nonASCIIwhitespace} from "./whitespace.js"
import {codePointToString} from "./util.js"
import {Macro} from "./preprocess-macro.js"
import {PositionOffset} from "./preprocess-tokenizer.js"

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.

export class Token {
  constructor(p) {
    this.type = p.type
    this.value = p.value
    this.start = p.start
    this.end = p.end
    if (p.tokMacroOffset) this.tokMacroOffset = p.tokMacroOffset
    if (p.options.locations)
      this.loc = new SourceLocation(p, p.startLoc, p.endLoc)
    if (p.options.ranges)
      this.range = [p.start, p.end]
  }
}

// ## Tokenizer

const pp = Parser.prototype

// Move to the next token

pp.next = function(ignoreEscapeSequenceInKeyword, stealth, onlyTransformArguments) {
  if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc)
    this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword)
  if (this.options.onToken)
    this.options.onToken(new Token(this))

  if (!stealth) {
    this.lastTokEnd = this.end
    this.lastTokStart = this.start
    this.lastTokEndLoc = this.endLoc
    this.lastTokStartLoc = this.startLoc
    this.lastEndOfFile = this.firstEndOfFile
    this.lastTokMacroOffset = this.tokMacroOffset
  }
  this.firstEndOfFile = null
  this.nodeMessageSendObjectExpression = null
  this.nextToken(stealth, onlyTransformArguments)
}

pp.getToken = function() {
  this.next()
  return new Token(this)
}

// If we're in an ES6 environment, make parsers iterable
if (typeof Symbol !== "undefined")
  pp[Symbol.iterator] = function() {
    return {
      next: () => {
        let token = this.getToken()
        return {
          done: token.type === tt.eof,
          value: token
        }
      }
    }
  }

// Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).

// Read a single token, updating the parser object's token-related
// properties.

pp.nextToken = function(stealth, onlyTransformMacroArguments) {
  let curContext = this.curContext()
  if (!curContext || !curContext.preserveSpace) this.skipSpace()

  this.start = this.pos
  this.tokInput = this.input
  if (!stealth) {
    this.lastEndInput = this.tokInput
    this.tokFirstStart = this.start
  }

  this.localLastEnd = this.firstEnd

  this.tokMacroOffset = this.tokPosMacroOffset
  this.preTokParameterScope = this.preprocessParameterScope

  if (this.options.locations) this.startLoc = this.curPosition()
  if (this.pos >= this.input.length) return this.finishToken(tt.eof)

  if (curContext.override) return curContext.override(this)
  else this.readToken(this.fullCharCodeAtPos(), stealth, onlyTransformMacroArguments)
}

pp.readToken = function(code, stealth, onlyTransformMacroArguments) {
  // Identifier or keyword. '\uXXXX' sequences are allowed in
  // identifiers, so '\' also dispatches to that.
  if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92 /* '\' */)
    return this.readWord(null, onlyTransformMacroArguments)
  return this.getTokenFromCode(code)
}

pp.fullCharCodeAtPos = function() {
  let code = this.input.charCodeAt(this.pos)
  if (code <= 0xd7ff || code >= 0xdc00) return code
  let next = this.input.charCodeAt(this.pos + 1)
  return next <= 0xdbff || next >= 0xe000 ? code : (code << 10) + next - 0x35fdc00
}

pp.skipBlockComment = function() {
  let startLoc = this.options.onComment && this.curPosition()
  let start = this.pos, end = this.input.indexOf("*/", this.pos += 2)
  if (end === -1) this.raise(this.pos - 2, "Unterminated comment")
  this.pos = end + 2
  if (this.options.locations) {
    for (let nextBreak, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1;) {
      ++this.curLine
      pos = this.lineStart = nextBreak
    }
  }
  if (this.options.onComment)
    this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos,
                           startLoc, this.curPosition())
}

pp.skipLineComment = function(startSkip) {
  let start = this.pos
  let startLoc = this.options.onComment && this.curPosition()
  let ch = this.input.charCodeAt(this.pos += startSkip)
  while (this.pos < this.input.length && !isNewLine(ch)) {
    ch = this.input.charCodeAt(++this.pos)
  }
  if (this.options.onComment)
    this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos,
                           startLoc, this.curPosition())
}

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

pp.skipSpace = function(dontSkipEOL, dontSkipMacroBoundary) {
  let ch
  loop: while (true) {
    if (this.pos >= this.input.length) {
      if (this.options.preprocess) {
        if (dontSkipMacroBoundary) return true
        if (!this.preprocessStack.length) break
        // If this is the first end of file after the token save to position to allow a semicolon to be inserted
        // the end of file, if needed.
        if (this.firstEndOfFile == null) this.firstEndOfFile = this.pos
        // If we are at the end of the input inside a macro continue at last position
        let lastItem = this.preprocessStack.pop()
        this.pos = lastItem.end
        this.input = lastItem.input
        this.curLine = lastItem.currentLine
        this.lineStart = lastItem.currentLineStart
        this.preprocessOnlyTransformArgumentsForLastToken = lastItem.onlyTransformArgumentsForLastToken
        this.preprocessParameterScope = lastItem.parameterScope
        this.tokPosMacroOffset = lastItem.macroOffset
        this.sourceFile = lastItem.sourceFile
        this.firstEnd = lastItem.lastEnd

        // Set the last item
        let lastIndex = this.preprocessStack.length
        this.preprocessStackLastItem = lastIndex ? this.preprocessStack[lastIndex - 1] : null
        return this.skipSpace(dontSkipEOL)
      } else {
        break
      }
    }
    ch = this.input.charCodeAt(this.pos)
    switch (ch) {
    case 32: case 160: // ' '
      ++this.pos
      break
    case 13:
      if (dontSkipEOL) break loop
      if (this.input.charCodeAt(this.pos + 1) === 10) {
        ++this.pos
      }
    case 10: case 8232: case 8233:
      if (dontSkipEOL) break loop
      ++this.pos
      if (this.options.locations) {
        ++this.curLine
        this.lineStart = this.pos
      }
      break
    case 47: // '/'
      switch (this.input.charCodeAt(this.pos + 1)) {
      case 42: // '*'
        this.skipBlockComment()
        break
      case 47:
        this.skipLineComment(2)
        break
      default:
        break loop
      }
      break
    case 92: // '\'
      if (!this.options.preprocess) break loop
      // Check if we have an escaped newline. We are using a relaxed treatment of escaped newlines like gcc.
      // We allow spaces, horizontal and vertical tabs, and form feeds between the backslash and the subsequent newline
      let pos = this.pos + 1
      ch = this.input.charCodeAt(pos)
      while (pos < this.input.length && (ch === 32 || ch === 9 || ch === 11 || ch === 12 || (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch)))))
        ch = this.input.charCodeAt(++pos)
      lineBreak.lastIndex = 0
      let match = lineBreak.exec(this.input.slice(pos, pos + 2))
      if (match && match.index === 0) {
        this.pos = pos + match[0].length
        if (this.options.locations) {
          ++this.curLine
          this.lineStart = this.pos
        }
      } else {
        break loop
      }
      break
    default:
      if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++this.pos
      } else {
        break loop
      }
    }
  }
  return ch
}

// Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.

pp.finishToken = function(type, val) {
  this.end = this.pos
  if (this.options.locations) this.endLoc = this.curPosition()
  let prevType = this.type
  this.type = type
  this.value = val
  this.updateContext(prevType)

  if (this.options.preprocess && this.preprocessPrescanFor(35, 35)) { // '##'
    this.skipSpace()
    let val1 = val != null ? val : type.label || type.type
    this.pos += 2
    if (val1 != null) {
      // Save current line and current line start. This is needed when option.locations is true
      let positionOffset = this.options.locations && new PositionOffset(this.curLine, this.lineStart)
      // Save positions on first token to get start and end correct on node if cancatenated token is invalid
      let saveTokInput = this.tokInput, saveTokEnd = this.end, saveTokStart = this.start, start = this.start + this.tokMacroOffset, variadicName = this.preprocessStackLastItem && this.preprocessStackLastItem.macro && this.preprocessStackLastItem.macro.variadicName
      this.skipSpace()
      let isVariadic
      if (variadicName && variadicName === this.input.slice(this.pos, this.pos + variadicName.length)) isVariadic = true
      this.preConcatenating = true
      this.nextToken(false, 2) // Don't transform macros
      this.preConcatenating = false
      let val2 = this.value != null ? this.value : this.type.keyword || this.type.label
      if (val2 != null) {
        // Skip token if it is a ',' concatenated with an empty variadic parameter
        if (isVariadic && val1 === "," && val2 === "") return this.nextToken()
        let concat = "" + val1 + val2, val2TokStart = this.start + this.tokPosMacroOffset
        this.skipSpace()
        // If the macro defines anything add it to the preprocess input stack
        let concatMacro = new Macro(null, concat, null, start, false, null, false, positionOffset)
        let r = this.readTokenFromMacro(concatMacro, this.tokPosMacroOffset, this.preprocessStackLastItem ? this.preprocessStackLastItem.parameterDict : null, null, this.pos, this.next, null)
        // Consumed the whole macro in one bite? If not the tokenizer can't create a single token from the two concatenated tokens
        if (this.preprocessStackLastItem && this.preprocessStackLastItem.macro === concatMacro && this.pos !== this.input.length) {
          this.type = type
          this.start = saveTokStart
          this.end = saveTokEnd
          this.tokInput = saveTokInput
          this.tokPosMacroOffset = val2TokStart - val1.length // reset the macro offset to the second token to get start and end correct on node
          if (!isVariadic) /* raise(tokStart, */console.warn("Warning: pasting formed '" + concat + "', an invalid preprocessing token")
        } else return r
      }
    }
  }
}

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function(finisher) {
  let next = this.input.charCodeAt(this.pos + 1)
  if (next >= 48 && next <= 57) return this.readNumber(true, pp.finishToken)
  let next2 = this.input.charCodeAt(this.pos + 2)
  if ((this.options.ecmaVersion >= 6 || this.preprocessIsParsingPreprocess || this.options.objj) && next === 46 && next2 === 46) { // 46 = dot '.'
    this.pos += 3
    return finisher.call(this, tt.ellipsis)
  } else {
    ++this.pos
    return finisher.call(this, tt.dot)
  }
}

pp.readToken_slash = function(finisher) { // '/'
  let next = this.input.charCodeAt(this.pos + 1)
  if (this.exprAllowed) { ++this.pos; return this.readRegexp() }
  if (next === 61) return this.finishOp(tt.assign, 2, finisher)
  return this.finishOp(tt.slash, 1, finisher)
}

pp.readToken_mult_modulo_exp = function(code, finisher) { // '%*'
  let next = this.input.charCodeAt(this.pos + 1)
  let size = 1
  let tokentype = code === 42 ? tt.star : tt.modulo

  // exponentiation operator ** and **=
  if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
    ++size
    tokentype = tt.starstar
    next = this.input.charCodeAt(this.pos + 2)
  }

  if (next === 61) return this.finishOp(tt.assign, size + 1, finisher)
  return this.finishOp(tokentype, size, finisher)
}

pp.readToken_pipe_amp = function(code, finisher) { // '|&'
  let next = this.input.charCodeAt(this.pos + 1)
  if (next === code) {
    if (this.options.ecmaVersion >= 12) {
      let next2 = this.input.charCodeAt(this.pos + 2)
      if (next2 === 61) return this.finishOp(tt.assign, 3, finisher)
    }
    return this.finishOp(code === 124 ? tt.logicalOR : tt.logicalAND, 2, finisher)
  }
  if (next === 61) return this.finishOp(tt.assign, 2, finisher)
  return this.finishOp(code === 124 ? tt.bitwiseOR : tt.bitwiseAND, 1, finisher)
}

pp.readToken_caret = function(finisher) { // '^'
  let next = this.input.charCodeAt(this.pos + 1)
  if (next === 61) return this.finishOp(tt.assign, 2, finisher)
  return this.finishOp(tt.bitwiseXOR, 1, finisher)
}

pp.readToken_plus_min = function(code, finisher) { // '+-'
  let next = this.input.charCodeAt(this.pos + 1)
  if (next === code) {
    if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 &&
        (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
      // A `-->` line comment
      this.skipLineComment(3)
      this.skipSpace()
      return this.nextToken()
    }
    return this.finishOp(tt.incDec, 2, finisher)
  }
  if (next === 61) return this.finishOp(tt.assign, 2, finisher)
  return this.finishOp(tt.plusMin, 1, finisher)
}

pp.readToken_lt_gt = function(code, finisher) { // '<>'
  if (code === 60 && (this.type === oatt._import || this.preType === ptt._preInclude) && this.options.objj) { // '<'
    for (let start = this.pos + 1;;) {
      let ch = this.input.charCodeAt(++this.pos)
      if (ch === 62) // '>'
        return finisher.call(this, ott._filename, this.input.slice(start, this.pos++))
      if (this.pos >= this.input.length || ch === 13 || ch === 10 || ch === 8232 || ch === 8233)
        this.raise(this.start, "Unterminated import statement")
    }
  }
  let next = this.input.charCodeAt(this.pos + 1)
  let size = 1
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2
    if (this.input.charCodeAt(this.pos + size) === 61) return this.finishOp(tt.assign, size + 1, finisher)
    return this.finishOp(tt.bitShift, size, finisher)
  }
  if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 &&
      this.input.charCodeAt(this.pos + 3) === 45) {
    // `<!--`, an XML-style comment that should be interpreted as a line comment
    this.skipLineComment(4)
    this.skipSpace()
    return this.nextToken()
  }
  if (next === 61) size = 2
  return this.finishOp(tt.relational, size, finisher)
}

pp.readToken_eq_excl = function(code, finisher) { // '=!'
  let next = this.input.charCodeAt(this.pos + 1)
  if (next === 61) return this.finishOp(tt.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2, finisher)
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) { // '=>'
    this.pos += 2
    return finisher.call(this, tt.arrow)
  }
  return this.finishOp(code === 61 ? tt.eq : tt.prefix, 1, finisher)
}

pp.readToken_question = function() { // '?'
  const ecmaVersion = this.options.ecmaVersion
  if (ecmaVersion >= 11) {
    let next = this.input.charCodeAt(this.pos + 1)
    if (next === 46) {
      let next2 = this.input.charCodeAt(this.pos + 2)
      if (next2 < 48 || next2 > 57) return this.finishOp(tt.questionDot, 2)
    }
    if (next === 63) {
      if (ecmaVersion >= 12) {
        let next2 = this.input.charCodeAt(this.pos + 2)
        if (next2 === 61) return this.finishOp(tt.assign, 3)
      }
      return this.finishOp(tt.coalesce, 2)
    }
  }
  return this.finishOp(tt.question, 1)
}

pp.readToken_numberSign = function(finisher) { // '#'
  if (this.preprocessIsParsingPreprocess) {
    ++this.pos
    return finisher.call(this, ptt._preprocess)
  }

  // Check if it is the first token on the line
  lineBreak.lastIndex = 0
  let match = lineBreak.exec(this.input.slice(this.localLastEnd, this.pos))
  if (this.lastEnd !== 0 && this.lastEnd !== this.pos && !match && ((this.preprocessStackLastItem && !this.preprocessStackLastItem.isIncludeFile) || this.pos !== 0)) {
    if (this.preprocessStackLastItem) {
      // Stringify next token
      return this.preprocessStringify()
    }
  }

  const ecmaVersion = this.options.ecmaVersion
  let code = 35 // '#'
  let numberSignPos = this.pos++
  let wordStart = this.pos
  let wordStartCode = this.fullCharCodeAtPos()
  let errorPos = numberSignPos
  let word = this.readWord1()
  preprocess: if (this.options.preprocess) {
    if (word.length === 0) {
      this.skipSpace()
      word = this.readWord1()
    }
    // Check if it is the first token on the line
    lineBreak.lastIndex = 0
    let match = lineBreak.exec(this.input.slice(this.localLastEnd, numberSignPos))
    if (this.lastTokEnd === 0 || this.lastTokEnd === numberSignPos || match || (!(this.preprocessStackLastItem && !this.preprocessStackLastItem.isIncludeFile) && numberSignPos === 0)) {
      switch (word) {
      case "pragma":
        this.preStart = this.start
        this.preprocesSkipRestOfLine()
        break

      case "define":
        this.preStart = this.start
        if (this.preNotSkipping) {
          this.preprocessParseDefine()
        } else {
          return finisher.call(this, ptt._preDefine)
        }
        break

      case "undef":
        this.preprocessReadToken()
        this.options.preprocessUndefineMacro(this.preprocessGetIdent())
        break

      case "if":
        this.preStart = this.start
        if (this.preNotSkipping) {
          // We dont't allow regex when parsing preprocess expression
          // FIXME: Here we should probably use the context functionality.
          let saveTokRegexpAllowed = this.exprAllowed
          this.exprAllowed = false
          // this.tokRegexpAllowed = false;
          this.preIfLevel.push(ptt._preIf)
          this.preprocessReadToken(false, false, true)
          let expr = this.preprocessParseExpression(true) // Process macros
          let test = this.preprocessEvalExpression(expr)
          if (!test) {
            this.preNotSkipping = false
            this.preprocessSkipToElseOrEndif()
          }
          this.exprAllowed = saveTokRegexpAllowed
        } else {
          return finisher.call(this, ptt._preIf)
        }
        break

      case "ifdef":
        this.preStart = this.start
        if (this.preNotSkipping) {
          this.preIfLevel.push(ptt._preIf)
          this.preprocessReadToken()
          let identifer = this.preprocessGetIdent()
          let isMacro = this.options.preprocessIsMacro(identifer)

          if (!isMacro) {
            this.preNotSkipping = false
            this.preprocessSkipToElseOrEndif()
          }
        } else {
          return finisher.call(this, ptt._preIfdef)
        }
        break

      case "ifndef":
        this.preStart = this.start
        if (this.preNotSkipping) {
          this.preIfLevel.push(ptt._preIf)
          this.preprocessReadToken()
          let identifer = this.preprocessGetIdent()
          let isMacro = this.options.preprocessIsMacro(identifer)

          if (isMacro) {
            this.preNotSkipping = false
            this.preprocessSkipToElseOrEndif()
          }
        } else {
          return finisher.call(this, ptt._preIfdef)
        }
        break

      case "elif":
        this.preStart = this.start
        if (this.preIfLevel.length) {
          if (this.preNotSkipping) {
            if (this.preIfLevel[this.preIfLevel.length - 1] === ptt._preIf) {
              this.preNotSkipping = false
              finisher.call(this, ptt._preElseIf)
              this.preprocessReadToken()
              this.preprocessSkipToElseOrEndif(true) // no else
            } else
              this.raise(this.preStart, "#elsif after #else")
          } else {
            // We dont't allow regex when parsing preprocess expression
            let saveTokRegexpAllowed = this.exprAllowed
            this.exprAllowed = false
            this.preNotSkipping = true
            this.preprocessReadToken(false, false, true)
            let expr = this.preprocessParseExpression(true)
            this.preNotSkipping = false
            this.tokRegexpAllowed = saveTokRegexpAllowed
            let test = this.preprocessEvalExpression(expr)
            return finisher.call(this, test ? ptt._preElseIfTrue : ptt._preElseIfFalse)
          }
        } else
          this.raise(this.preStart, "#elif without #if")
        break

      case "else":
        this.preStart = this.start
        if (this.preIfLevel.length) {
          if (this.preNotSkipping) {
            if (this.preIfLevel[this.preIfLevel.length - 1] === ptt._preIf) {
              this.preIfLevel[this.preIfLevel.length - 1] = ptt._preElse
              this.preNotSkipping = false
              finisher.call(this, ptt._preElse)
              this.preprocessReadToken()
              this.preprocessSkipToElseOrEndif(true) // no else
            } else
              this.raise(this.preStart, "#else after #else")
          } else {
            this.preIfLevel[this.preIfLevel.length - 1] = ptt._preElse
            return finisher.call(this, ptt._preElse)
          }
        } else
          this.raise(this.preStart, "#else without #if")
        break

      case "endif":
        this.preStart = this.start
        if (this.preIfLevel.length) {
          if (this.preNotSkipping) {
            this.preIfLevel.pop()
            break
          }
        } else {
          this.raise(this.preStart, "#endif without #if")
        }
        return finisher.call(this, ptt._preEndif)

      case "include":
        if (!this.preNotSkipping) {
          return finisher.call(this, ptt._preInclude)
        }
        this.preprocessReadToken()
        let localfilepath
        if (this.preType === tt.string)
          localfilepath = true
        else if (this.preType === ptt._filename)
          localfilepath = false
        else
          this.raise(this.preStart, "Expected \"FILENAME\" or <FILENAME>: " + (this.preType.keyword || this.preType.type))

        let theFileName = this.preVal
        let includeDict = this.options.preprocessGetIncludeFile(this.preVal, localfilepath) || this.raise(this.preStart, "'" + theFileName + "' file not found")
        let includeString = includeDict.include
        let includeMacro = new Macro(null, includeString, null, 0, false, null, false, null, includeDict.sourceFile)
        this.preprocessFinishToken(ptt._preprocess, null, null, true) // skipEOL
        this.pushMacroToStack(includeMacro, includeMacro.macro, this.tokPosMacroOffset, null, null, this.pos, null, true) // isIncludeFile
        this.skipSpace()
        this.nextToken(true)
        // this.readToken(null, null, true); // Stealth
        return

      case "error":
        let start = this.preStart
        this.preprocessReadToken(false, false, true)
        this.raise(start, "Error: " + String(this.preprocessEvalExpression(this.preprocessParseExpression())))
        break

      case "warning":
        this.preprocessReadToken(false, false, true)
        console.warn("Warning: " + String(this.preprocessEvalExpression(this.preprocessParseExpression())))
        break

      default:
        break preprocess
      }
      this.preprocessFinishToken(this.preType, null, null, true)
      return this.next(false, true)
    } else if (isKeywordPreprocessor.test(word)) {
      this.raise(errorPos, "Preprocessor directives may only be used at the beginning of a line")
    }
  }
  if (ecmaVersion >= 13) {
    errorPos = wordStart
    code = wordStartCode
    // code = this.fullCharCodeAtPos()
    if (isIdentifierStart(wordStartCode, true) || wordStartCode === 92 /* '\' */) {
      return this.finishToken(tt.privateId, word)
    }
  }
  this.raise(errorPos, "Unexpected character '" + codePointToString(code) + "'")
}

pp.readToken_at = function(code, finisher) { // '@'
  let next = this.input.charCodeAt(++this.pos)
  if (next === 34 || next === 39) { // Read string if "'" or '"'
    let tmp = this.readString(next, finisher)
    return tmp
  }
  if (next === 123) // Read dictionary literal if "{"
    return finisher.call(this, oatt._dictionaryLiteral)
  if (next === 91) // Read array literal if "["
    return finisher.call(this, oatt._arrayLiteral)

  let word = this.readWord1(),
      token = objjAtKeywords[word]
  if (!token) this.raise(this.tokStart, "Unrecognized Objective-J keyword '@" + word + "'")
  return finisher.call(this, token)
}

pp.getTokenFromCode = function(code, finisher = this.finishToken, allowEndOfLineToken) {
  switch (code) {
  // The interpretation of a dot depends on whether it is followed
  // by a digit or another two dots.
  case 46: // '.'
    return this.readToken_dot(finisher)

  // Punctuation tokens.
  case 40: ++this.pos; return finisher.call(this, tt.parenL)
  case 41: ++this.pos; return finisher.call(this, tt.parenR)
  case 59: ++this.pos; return finisher.call(this, tt.semi)
  case 44: ++this.pos; return finisher.call(this, tt.comma)
  case 91: ++this.pos; return finisher.call(this, tt.bracketL)
  case 93: ++this.pos; return finisher.call(this, tt.bracketR)
  case 123: ++this.pos; return finisher.call(this, tt.braceL)
  case 125: ++this.pos; return finisher.call(this, tt.braceR)
  case 58: ++this.pos; return finisher.call(this, tt.colon)

  case 96: // '`'
    if (this.options.ecmaVersion < 6) break
    ++this.pos
    return finisher.call(this, tt.backQuote)

  case 48: // '0'
    let next = this.input.charCodeAt(this.pos + 1)
    if (next === 120 || next === 88) return this.readRadixNumber(16, finisher) // '0x', '0X' - hex number
    if (this.options.ecmaVersion >= 6) {
      if (next === 111 || next === 79) return this.readRadixNumber(8, finisher) // '0o', '0O' - octal number
      if (next === 98 || next === 66) return this.readRadixNumber(2, finisher) // '0b', '0B' - binary number
    }

  // Anything else beginning with a digit is an integer, octal
  // number, or float.
  case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
    return this.readNumber(false, finisher)

  // Quotes produce strings.
  case 34: case 39: // '"', "'"
    return this.readString(code, finisher)

  // Operators are parsed inline in tiny state machines. '=' (61) is
  // often referred to. `finishOp` simply skips the amount of
  // characters it is given as second argument, and returns a token
  // of the type given by its first argument.
  case 47: // '/'
    return this.readToken_slash(finisher)

  case 37: case 42: // '%*'
    return this.readToken_mult_modulo_exp(code, finisher)

  case 124: case 38: // '|&'
    return this.readToken_pipe_amp(code, finisher)

  case 94: // '^'
    return this.readToken_caret(finisher)

  case 43: case 45: // '+-'
    return this.readToken_plus_min(code, finisher)

  case 60: case 62: // '<>'
    return this.readToken_lt_gt(code, finisher)

  case 61: case 33: // '=!'
    return this.readToken_eq_excl(code, finisher)

  case 63: // '?'
    return this.readToken_question()

  case 126: // '~'
    return this.finishOp(tt.prefix, 1, finisher)

  case 35: // '#'
    return this.readToken_numberSign(finisher)

  case 92: // '\'
    if (this.options.preprocess) {
      return this.finishOp(ptt._preBackslash, 1, finisher)
    }

  case 64: // '@'
    if (this.options.objj)
      return this.readToken_at(code, finisher)
    return false
  }
  if (allowEndOfLineToken) {
    if (code === 13 || code === 10 || code === 8232 || code === 8233) {
      let size = (code === 13 && this.input.charCodeAt(this.pos + 1) === 10) ? 2 : 1
      if (this.options.locations) {
        this.lineStart = this.pos + size; ++this.curLine
      }
      return this.finishOp(tt.eol, size, finisher)
    }
  }
  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'")
}

// Stringify next token and return with it as a literal string.

pp.preprocessStringify = function() {
  let saveStackLength = this.preprocessStack.length, saveLastItem = this.preprocessStackLastItem
  this.pos++ // Skip '#'
  this.preConcatenating = true // To get empty sting if macro is empty
  this.next(false, false, 2) // Don't prescan arguments
  this.preConcatenating = false
  let start = this.start + this.tokMacroOffset
  let positionOffset = this.options.locations && new PositionOffset(this.curLine, this.lineStart)
  let string
  if (this.type === tt.string) {
    let quote = this.tokInput.slice(this.start, this.start + 1)
    let escapedQuote = quote === "\"" ? "\\\"" : "'"
    string = escapedQuote
    string += preprocessStringifyEscape(this.value)
    string += escapedQuote
  } else {
    string = this.value != null ? this.value : this.type.keyword || this.type.label
  }
  while (this.preprocessStack.length > saveStackLength && saveLastItem === this.preprocessStack[saveStackLength - 1] && this.pos !== this.input.length) {
    this.preConcatenating = true // To get empty sting if macro is empty
    this.next(false, false, 2) // Don't prescan arguments
    this.preConcatenating = false
    // Add a space if there is one or more withespaces
    if (this.lastEnd !== this.start) string += " "
    if (this.type === tt.string) {
      let quote = this.tokInput.slice(this.start, this.start + 1)
      let escapedQuote = quote === "\"" ? "\\\"" : "'"
      string += escapedQuote
      string += preprocessStringifyEscape(this.value)
      string += escapedQuote
    } else {
      string += this.value != null ? this.value : this.type.keyword || this.type.label
    }
  }
  let stringifyMacro = new Macro(null, "\"" + string + "\"", null, start, false, null, false, positionOffset)
  return this.readTokenFromMacro(stringifyMacro, this.tokPosMacroOffset, null, null, this.pos, this.next)
}

// Escape characters in stringify string.

function preprocessStringifyEscape(aString) {
  let escaped, pos, size, ch
  for (escaped = "", pos = 0, size = aString.length, ch = aString.charCodeAt(pos); pos < size; ch = aString.charCodeAt(++pos)) {
    switch (ch) {
    case 34: escaped += "\\\\\\\""; break // "
    case 10: escaped += "\\\\n"; break // LF (\n)
    case 13: escaped += "\\\\r"; break // CR (\r)
    case 9: escaped += "\\\\t"; break // TAB (\t)
    case 8: escaped += "\\\\b"; break // BS (\b)
    case 11: escaped += "\\\\v"; break // VT (\v)
    case 0x00A0: escaped += "\\\\u00A0"; break // CR (\r)
    case 0x2028: escaped += "\\\\u2028"; break // LINE SEPARATOR
    case 0x2029: escaped += "\\\\u2029"; break // PARAGRAPH SEPARATOR
    case 92: escaped += "\\\\"; break // BACKSLASH
    default: escaped += aString.charAt(pos); break
    }
  }
  return escaped
}

pp.finishOp = function(type, size, finisher = this.finishToken) {
  let str = this.input.slice(this.pos, this.pos + size)
  this.pos += size
  return finisher.call(this, type, str)
}

pp.readRegexp = function() {
  let escaped, inClass, start = this.pos
  for (;;) {
    if (this.pos >= this.input.length) this.raise(start, "Unterminated regular expression")
    let ch = this.input.charAt(this.pos)
    if (lineBreak.test(ch)) this.raise(start, "Unterminated regular expression")
    if (!escaped) {
      if (ch === "[") inClass = true
      else if (ch === "]" && inClass) inClass = false
      else if (ch === "/" && !inClass) break
      escaped = ch === "\\"
    } else escaped = false
    ++this.pos
  }
  let pattern = this.input.slice(start, this.pos)
  ++this.pos
  let flagsStart = this.pos
  let flags = this.readWord1()
  if (this.containsEsc) this.unexpected(flagsStart)

  // Validate pattern
  const state = this.regexpState || (this.regexpState = new RegExpValidationState(this))
  state.reset(start, pattern, flags)
  this.validateRegExpFlags(state)
  this.validateRegExpPattern(state)

  // Create Literal#value property value.
  let value = null
  try {
    value = new RegExp(pattern, flags)
  } catch (e) {
    // ESTree requires null if it failed to instantiate RegExp object.
    // https://github.com/estree/estree/blob/a27003adf4fd7bfad44de9cef372a2eacd527b1c/es5.md#regexpliteral
  }

  return this.finishToken(tt.regexp, {pattern, flags, value})
}

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
  // `len` is used for character escape sequences. In that case, disallow separators.
  const allowSeparators = this.options.ecmaVersion >= 12 && len === undefined

  // `maybeLegacyOctalNumericLiteral` is true if it doesn't have prefix (0x,0o,0b)
  // and isn't fraction part nor exponent part. In that case, if the first digit
  // is zero then disallow separators.
  const isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48

  let start = this.pos, total = 0, lastCode = 0
  for (let i = 0, e = len == null ? Infinity : len; i < e; ++i, ++this.pos) {
    let code = this.input.charCodeAt(this.pos), val

    if (allowSeparators && code === 95) {
      if (isLegacyOctalNumericLiteral) this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals")
      if (lastCode === 95) this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore")
      if (i === 0) this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits")
      lastCode = code
      continue
    }

    if (code >= 97) val = code - 97 + 10 // a
    else if (code >= 65) val = code - 65 + 10 // A
    else if (code >= 48 && code <= 57) val = code - 48 // 0-9
    else val = Infinity
    if (val >= radix) break
    lastCode = code
    total = total * radix + val
  }

  if (allowSeparators && lastCode === 95) this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits")
  if (this.pos === start || len != null && this.pos - start !== len) return null

  return total
}

function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8)
  }

  // `parseFloat(value)` stops parsing at the first numeric separator then returns a wrong value.
  return parseFloat(str.replace(/_/g, ""))
}

function stringToBigInt(str) {
  if (typeof BigInt !== "function") {
    return null
  }

  // `BigInt(value)` throws syntax error if the string contains numeric separators.
  return BigInt(str.replace(/_/g, ""))
}

pp.readRadixNumber = function(radix, finisher) {
  let start = this.pos
  this.pos += 2 // 0x
  let val = this.readInt(radix)
  if (val == null) this.raise(this.start + 2, "Expected number in radix " + radix)
  if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
    val = stringToBigInt(this.input.slice(start, this.pos))
    ++this.pos
  } else if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number")
  return finisher.call(this, tt.num, val)
}

// Read an integer, octal integer, or floating-point number.

pp.readNumber = function(startsWithDot, finisher) {
  let start = this.pos
  if (!startsWithDot && this.readInt(10, undefined, true) === null) this.raise(start, "Invalid number")
  let octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48
  if (octal && this.strict) this.raise(start, "Invalid number")
  let next = this.input.charCodeAt(this.pos)
  if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
    let val = stringToBigInt(this.input.slice(start, this.pos))
    ++this.pos
    if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number")
    return finisher.call(this, tt.num, val)
  }
  if (octal && /[89]/.test(this.input.slice(start, this.pos))) octal = false
  if (next === 46 && !octal) { // '.'
    ++this.pos
    this.readInt(10)
    next = this.input.charCodeAt(this.pos)
  }
  if ((next === 69 || next === 101) && !octal) { // 'eE'
    next = this.input.charCodeAt(++this.pos)
    if (next === 43 || next === 45) ++this.pos // '+-'
    if (this.readInt(10) === null) this.raise(start, "Invalid number")
  }
  if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number")

  let val = stringToNumber(this.input.slice(start, this.pos), octal)
  return finisher.call(this, tt.num, val)
}

// Read a string value, interpreting backslash-escapes.

pp.readCodePoint = function() {
  let ch = this.input.charCodeAt(this.pos), code

  if (ch === 123) { // '{'
    if (this.options.ecmaVersion < 6) this.unexpected()
    let codePos = ++this.pos
    code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos)
    ++this.pos
    if (code > 0x10FFFF) this.invalidStringToken(codePos, "Code point out of bounds")
  } else {
    code = this.readHexChar(4)
  }
  return code
}

pp.readString = function(quote, finisher) {
  let out = "", chunkStart = ++this.pos
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated string constant")
    let ch = this.input.charCodeAt(this.pos)
    if (ch === quote) break
    if (ch === 92) { // '\'
      out += this.input.slice(chunkStart, this.pos)
      out += this.readEscapedChar(false)
      chunkStart = this.pos
    } else if (ch === 0x2028 || ch === 0x2029) {
      if (this.options.ecmaVersion < 10) this.raise(this.start, "Unterminated string constant")
      ++this.pos
      if (this.options.locations) {
        this.curLine++
        this.lineStart = this.pos
      }
    } else {
      if (isNewLine(ch)) this.raise(this.start, "Unterminated string constant")
      ++this.pos
    }
  }
  out += this.input.slice(chunkStart, this.pos++)
  return finisher.call(this, tt.string, out)
}

// Reads template string tokens.

const INVALID_TEMPLATE_ESCAPE_ERROR = {}

pp.tryReadTemplateToken = function() {
  this.inTemplateElement = true
  try {
    this.readTmplToken()
  } catch (err) {
    if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
      this.readInvalidTemplateToken()
    } else {
      throw err
    }
  }

  this.inTemplateElement = false
}

pp.invalidStringToken = function(position, message) {
  if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
    throw INVALID_TEMPLATE_ESCAPE_ERROR
  } else {
    this.raise(position, message)
  }
}

pp.readTmplToken = function() {
  let out = "", chunkStart = this.pos
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated template")
    let ch = this.input.charCodeAt(this.pos)
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) { // '`', '${'
      if (this.pos === this.start && (this.type === tt.template || this.type === tt.invalidTemplate)) {
        if (ch === 36) {
          this.pos += 2
          return this.finishToken(tt.dollarBraceL)
        } else {
          ++this.pos
          return this.finishToken(tt.backQuote)
        }
      }
      out += this.input.slice(chunkStart, this.pos)
      return this.finishToken(tt.template, out)
    }
    if (ch === 92) { // '\'
      out += this.input.slice(chunkStart, this.pos)
      out += this.readEscapedChar(true)
      chunkStart = this.pos
    } else if (isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos)
      ++this.pos
      switch (ch) {
      case 13:
        if (this.input.charCodeAt(this.pos) === 10) ++this.pos
      case 10:
        out += "\n"
        break
      default:
        out += String.fromCharCode(ch)
        break
      }
      if (this.options.locations) {
        ++this.curLine
        this.lineStart = this.pos
      }
      chunkStart = this.pos
    } else {
      ++this.pos
    }
  }
}

// Reads a template token to search for the end, without validating any escape sequences
pp.readInvalidTemplateToken = function() {
  for (; this.pos < this.input.length; this.pos++) {
    switch (this.input[this.pos]) {
    case "\\":
      ++this.pos
      break

    case "$":
      if (this.input[this.pos + 1] !== "{") {
        break
      }

    // falls through
    case "`":
      return this.finishToken(tt.invalidTemplate, this.input.slice(this.start, this.pos))

    // no default
    }
  }
  this.raise(this.start, "Unterminated template")
}

// Used to read escaped characters

pp.readEscapedChar = function(inTemplate) {
  let ch = this.input.charCodeAt(++this.pos)
  ++this.pos
  switch (ch) {
  case 110: return "\n" // 'n' -> '\n'
  case 114: return "\r" // 'r' -> '\r'
  case 120: return String.fromCharCode(this.readHexChar(2)) // 'x'
  case 117: return codePointToString(this.readCodePoint()) // 'u'
  case 116: return "\t" // 't' -> '\t'
  case 98: return "\b" // 'b' -> '\b'
  case 118: return "\u000b" // 'v' -> '\u000b'
  case 102: return "\f" // 'f' -> '\f'
  case 13: if (this.input.charCodeAt(this.pos) === 10) ++this.pos // '\r\n'
  case 10: // ' \n'
    if (this.options.locations) { this.lineStart = this.pos; ++this.curLine }
    return ""
  case 56:
  case 57:
    if (this.strict) {
      this.invalidStringToken(
        this.pos - 1,
        "Invalid escape sequence"
      )
    }
    if (inTemplate) {
      const codePos = this.pos - 1

      this.invalidStringToken(
        codePos,
        "Invalid escape sequence in template string"
      )

      return null
    }
  default:
    if (ch >= 48 && ch <= 55) {
      let octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0]
      let octal = parseInt(octalStr, 8)
      if (octal > 255) {
        octalStr = octalStr.slice(0, -1)
        octal = parseInt(octalStr, 8)
      }
      this.pos += octalStr.length - 1
      ch = this.input.charCodeAt(this.pos)
      if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
        this.invalidStringToken(
          this.pos - 1 - octalStr.length,
          inTemplate
            ? "Octal literal in template string"
            : "Octal literal in strict mode"
        )
      }
      return String.fromCharCode(octal)
    }
    if (isNewLine(ch)) {
      // Unicode new line characters after \ get removed from output in both
      // template literals and strings
      return ""
    }
    return String.fromCharCode(ch)
  }
}

// Used to read character escape sequences ('\x', '\u', '\U').

pp.readHexChar = function(len) {
  let codePos = this.pos
  let n = this.readInt(16, len)
  if (n === null) this.invalidStringToken(codePos, "Bad character escape sequence")
  return n
}

// Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.

pp.readWord1 = function() {
  this.containsEsc = false
  let word = "", first = true, chunkStart = this.pos
  let astral = this.options.ecmaVersion >= 6
  while (this.pos < this.input.length) {
    let ch = this.fullCharCodeAtPos()
    if (isIdentifierChar(ch, astral)) {
      this.pos += ch <= 0xffff ? 1 : 2
    } else if (ch === 92) { // "\"
      this.containsEsc = true
      word += this.input.slice(chunkStart, this.pos)
      let escStart = this.pos
      if (this.input.charCodeAt(++this.pos) !== 117) // "u"
        this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX")
      ++this.pos
      let esc = this.readCodePoint()
      if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral))
        this.invalidStringToken(escStart, "Invalid Unicode escape")
      word += codePointToString(esc)
      chunkStart = this.pos
    } else {
      break
    }
    first = false
  }
  return word + this.input.slice(chunkStart, this.pos)
}

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

pp.readWord = function(preReadWord, onlyTransformMacroArguments) {
  let word = preReadWord || this.readWord1()
  let type = tt.name
  if (this.options.preprocess) {
    let readMacroWordReturn = this.readMacroWord(word, this.next, onlyTransformMacroArguments)
    if (readMacroWordReturn === true)
      return true
  }
  if (this.keywords.test(word)) {
    type = keywords[word]
  } else if (this.options.objj && Object.prototype.hasOwnProperty.call(objjKeywords, word)) {
    type = objjKeywords[word]
  }
  return this.finishToken(type, word)
}
