ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  const html = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js;
  const plain = $.NSString.stringWithContentsOfFileEncodingError(argv[1], $.NSUTF8StringEncoding, null).js;
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType(html, $.NSPasteboardTypeHTML);
  pb.setStringForType(plain, $.NSPasteboardTypeString);
  const types = ObjC.deepUnwrap(pb.types);
  const back = pb.stringForType($.NSPasteboardTypeHTML).js;
  return JSON.stringify({types: types, html_roundtrip_equal: back === html, html_chars: back.length});
}
