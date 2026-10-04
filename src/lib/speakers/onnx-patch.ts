/**
 * In-memory fix for the CAM++ ONNX export, applied after download (the stored file stays byte-identical
 * to the pinned one).
 *
 * CAM++'s context-aware masking averages each 100-frame segment with
 * AveragePool(kernel 100, stride 100, pads 0, ceil_mode 1, count_include_pad 1). The last segment of an
 * input is usually partial. PyTorch, which the model was trained with, divides that partial segment by the
 * frames it actually contains; ONNX Runtime up to at least 1.24 (onnxruntime-web 1.24.1 and the 1.22 build
 * in transformers.js) divides by the full kernel instead, which shrinks the last segment's context and
 * changes every embedding (cosine 0.28 to the correct one on a 4.7 s test clip, and same-speaker pairs no
 * longer score above different-speaker pairs). Newer ONNX Runtime (1.30) matches PyTorch.
 *
 * With no padding, count_include_pad 0 has exactly PyTorch's semantics on every ONNX Runtime version, so this
 * flips the attribute in every AveragePool node. A serialized AttributeProto is
 * `0x0A len "count_include_pad" 0x18 <varint i>`; 1 and 0 are both one byte, so the patch is in place.
 */

const ATTRIBUTE = new TextEncoder().encode('count_include_pad');
/** field 1 (name, length-delimited), length, name bytes, field 3 (i, varint) tag. */
const PATTERN = Uint8Array.from([0x0a, ATTRIBUTE.length, ...ATTRIBUTE, 0x18]);

/** Sets count_include_pad to 0 wherever it is 1. Returns how many attributes were changed. */
export function disableCountIncludePad(model: Uint8Array): number {
  let patched = 0;
  const last = model.length - PATTERN.length - 1;
  outer: for (let i = 0; i <= last; i++) {
    if (model[i] !== PATTERN[0]) continue;
    for (let j = 1; j < PATTERN.length; j++) if (model[i + j] !== PATTERN[j]) continue outer;
    const value = i + PATTERN.length;
    if (model[value] === 0x01) {
      model[value] = 0x00;
      patched++;
    }
    i = value;
  }
  return patched;
}
