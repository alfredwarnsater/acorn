import {Parser} from "./state.js"
import {Position, getLineInfo} from "./locutil.js"

const pp = Parser.prototype

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

pp.raise = function(pos, message) {
  let loc = getLineInfo(this.input, pos)
  message += " (" + loc.line + ":" + loc.column + ")"
  let err = new SyntaxError(message)
  err.pos = pos; err.loc = loc; err.raisedAt = this.pos
  throw err
}

pp.raiseRecoverable = pp.raise

pp.curPosition = function() {
  if (this.options.locations) {
    let line = this.curLine
    let column = this.pos - this.lineStart
    if (this.preprocessStackLastItem) {
      let macro = this.preprocessStackLastItem.macro
      let locationOffset = macro.locationOffset
      if (locationOffset) {
        let macroCurrentLine = locationOffset.line
        if (macroCurrentLine) line += macroCurrentLine
        let macroCurrentLineStart = locationOffset.column
        // Only add column offset if we are on the first line
        if (macroCurrentLineStart) {
          column += this.tokPosMacroOffset - (this.curLine === 1 ? macroCurrentLineStart : 0)
        }
      }
    }
    return new Position(line, column)
  }
}
