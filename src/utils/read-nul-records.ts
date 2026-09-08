import { MAX_COMMAND_OUTPUT_BYTES } from '../constants'

/** Decodes Git's streamed NUL records for {@link stageSource} without splitting unusual filenames.
 * @param chunks - Raw subprocess output.
 * @returns Complete UTF-8 records in order.
 * @example for await (const path of readNulRecords(stream)) console.log(path);
 */
export async function* readNulRecords(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0)
  for await (const chunk of chunks) {
    const data = Buffer.concat([pending, chunk])
    let start = 0
    let end = data.indexOf(0, start)
    // Decode only complete records; UTF-8 characters may cross stream chunks.
    while (end !== -1) {
      yield new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        data.subarray(start, end),
      )
      start = end + 1
      end = data.indexOf(0, start)
    }
    pending = Buffer.from(data.subarray(start))
    if (pending.length > MAX_COMMAND_OUTPUT_BYTES)
      throw new Error('Git emitted an oversized path record.')
  }
  if (pending.length !== 0)
    throw new Error('Git output ended with an incomplete path record.')
}
