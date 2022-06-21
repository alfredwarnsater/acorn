import { wordsRegexp } from "./util.js"

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
    return this.isParameterFunctionVar || (this.isParameterFunctionVar = wordsRegexp((this.parameters || []).join(" ")))
  }
}
