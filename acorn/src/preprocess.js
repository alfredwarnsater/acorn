import {types as tt, keywords as keywordTypes} from "./tokentype.js"
import {Parser} from "./state.js"

const pp = Parser.prototype

pp.preprocesSkipRestOfLine = function() {
    var ch = this.input.charCodeAt(this.pos);
    var last;
    // If the last none whitespace character is a '\' the line will continue on the the next line.
    // Here we break the way gcc works as it joins the lines first and then tokenize it. Because of
    // this we can't have a newline in the middle of a word.
    while (this.pos < this.input.length && ((ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) || last === 92)) { // White space and '\'
      if (ch != 32 && ch != 9 && ch != 160 && (ch < 5760 || !nonASCIIwhitespaceNoNewLine.test(String.fromCharCode(ch))))
        last = ch;
      ch = this.input.charCodeAt(++this.pos);
    }
  }
