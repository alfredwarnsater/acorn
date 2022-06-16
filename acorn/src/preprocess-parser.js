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

    case ptt._eof:
      this.preNotSkipping = true
      this.raise(this.preStart, "Missing #endif")
    }
    this.preprocessReadToken(true)
  }
  this.preNotSkipping = true
  if (this.preType === ptt._preEndif)
    this.preIfLevel.pop()
}