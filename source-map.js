var fs = require('fs');
var srcURL = require('source-map-url');
var path = require('path');
var RSVP = require('rsvp');
var mkdirp = require('mkdirp');
var util = require('./util');
var Coder = require('./coder');

module.exports = SourceMap;
function SourceMap(opts) {
  if (!this instanceof SourceMap) {
    return new SourceMap(opts);
  }
  if (!opts || !opts.outputFile) {
    throw new Error("Must specify outputFile");
  }
  this.baseDir = opts.baseDir;
  this.outputFile = opts.outputFile;
  this._initializeStream();

  this.content = {
    version: 3,
    sources: [],
    sourcesContent: [],
    names: [],
    mappings: ''
  };
  if (opts.sourceRoot) {
    this.content.sourceRoot = opts.sourceRoot;
  }
  this.content.file = opts.file || path.basename(opts.outputFile);
  this.encoder = new Coder();

  // Keep track of what column we're currently outputing in the
  // generated file. Notice that we don't track line though -- line is
  // implicit in  this.content.mappings.
  this.column = 0;
}

SourceMap.prototype._resolveFile = function(filename) {
  if (this.baseDir && filename.slice(0,1) !== '/') {
    filename = path.join(this.baseDir, filename);
  }
  return filename;
};

SourceMap.prototype._initializeStream = function() {
  var filename = this._resolveFile(this.outputFile);
  mkdirp(path.dirname(filename));
  this.stream = fs.createWriteStream(filename);
};


SourceMap.prototype.addFile = function(filename) {
  var url;
  var source = fs.readFileSync(this._resolveFile(filename), 'utf-8');

  if (srcURL.existsIn(source)) {
    url = srcURL.getFrom(source);
    source = srcURL.removeFrom(source);
  }

  this.stream.write(source);

  if (url) {
    this._assimilateExistingMap(filename, url);
  } else {
    this.content.sources.push('/' + filename);
    this.content.sourcesContent.push(source);
    this._generateNewMap(source);
  }
};

// This is useful for things like separators that you're appending to
// your JS file that don't need to have their own source mapping, but
// will alter the line numbering for subsequent files.
SourceMap.prototype.addSpace = function(source) {
  this.stream.write(source);
  if (!this.shouldBuildMap) {
    return;
  }
  var lineCount = util.countLines(source);
  if (lineCount === 0) {
    this.column += source.length;
  } else {
    this.column = 0;
    var mappings = this.content.mappings;
    for (var i = 0; i < lineCount; i++) {
      mappings += ';';
    }
    this.content.mappings = mappings;
  }
};

SourceMap.prototype._generateNewMap = function(source) {
  var mappings = this.content.mappings;
  var lineCount = util.countLines(source);

  mappings += this.encoder.encode({
    generatedColumn: this.column,
    source: this.content.sources.length-1,
    originalLine: 0,
    originalColumn: 0
  });

  if (lineCount === 0) {
    // no newline in the source. Keep outputting one big line.
    this.column += source.length;
    mappings += ',';
  } else {
    // end the line
    this.column = 0;
    this.encoder.resetColumn();
    mappings += ';';
  }

  // For the remainder of the lines (if any), we're just following
  // one-to-one.
  for (var i = 0; i < lineCount-1; i++) {
    mappings += 'AACA;';
  }
  this.encoder.adjustLine(lineCount-1);

  this.content.mappings = mappings;
};

SourceMap.prototype._assimilateExistingMap = function(filename, url) {
  var srcMap = fs.readFileSync(path.join(path.dirname(this._resolveFile(filename)), url), 'utf8');
  srcMap = JSON.parse(srcMap);
  var content = this.content;
  var sourcesOffset = content.sources.length;
  var namesOffset = content.names.length;

  content.sources = content.sources.concat(srcMap.sources);
  content.sourcesContent = content.sourcesContent.concat(srcMap.sourcesContent);
  content.names = content.names.concat(srcMap.names);
  this._scanMappings(srcMap, sourcesOffset, namesOffset);
};

SourceMap.prototype._scanMappings = function(srcMap, sourcesOffset, namesOffset) {
  var mappings = this.content.mappings;
  var decoder = new Coder();
  var inputMappings = srcMap.mappings;
  var pattern = /^([;,]*)([^;,]*)/g;
  var continuation = /^[;,]*((?:AACA;)+)/;
  var match;

  while (inputMappings.length > 0) {
    pattern.lastIndex = 0;
    match = pattern.exec(inputMappings);

    // If the entry was preceded by separators, copy them through.
    if (match[1]) {
      mappings += match[1];
      if (match[1].indexOf(';') !== -1) {
        this.encoder.resetColumn();
      }
    }

    // Re-encode the entry.
    if (match[2]){
      var value = decoder.decode(match[2]);
      value.generatedColumn += this.column;
      this.column = 0;
      if (sourcesOffset && value.hasOwnProperty('source')) {
        value.source += sourcesOffset;
        decoder.prev_source += sourcesOffset;
        sourcesOffset = 0;
      }
      if (namesOffset && value.hasOwnProperty('name')) {
        value.name += namesOffset;
        decoder.prev_name += namesOffset;
        namesOffset = 0;
      }
      mappings += this.encoder.encode(value);
    }

    inputMappings = inputMappings.slice(pattern.lastIndex);

    // Once we've applied any offsets, we can try to jump ahead. This
    // is a significant optimization, especially when we're dong
    // simple line-for-line concatenations.
    if (!sourcesOffset && !namesOffset && (match = continuation.exec(inputMappings))) {
      var lines = match[1].length / 5;
      this.encoder.adjustLine(lines);
      decoder.adjustLine(lines);
      mappings += match[0];
      inputMappings = inputMappings.slice(match[0].length);
    }

  }
  this.content.mappings = mappings;
};

SourceMap.prototype.end = function() {
  var filename = this._resolveFile(this.outputFile).replace(/\.js$/, '') + '.map';
  this.stream.write('//# sourceMappingURL=' + path.basename(filename));
  fs.writeFileSync(filename, JSON.stringify(this.content));
  return new RSVP.Promise(function(resolve, reject) {
    this.stream.on('finish', resolve);
    this.stream.on('error', reject);
    this.stream.end();
  }.bind(this));
};