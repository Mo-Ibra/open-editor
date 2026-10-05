/**
 * Image imports.
 *
 * The render path for a still is the same one video uses, so what is worth
 * pinning down here is the part that decides a file *is* a still and how long
 * it is — everything downstream assumes both.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isImageFile, IMAGE_DURATION } from '../src/media/probe.js'

const file = (name: string, type: string): File => ({ name, type }) as File

describe('image import', () => {
  it('recognises stills by MIME type or by extension', () => {
    assert.equal(isImageFile(file('shot.png', '')), true, 'extension is the fallback')
    assert.equal(isImageFile(file('shot', 'image/jpeg')), true, 'MIME type is authoritative')
    assert.equal(isImageFile(file('shot.webp', 'image/webp')), true)
    assert.equal(isImageFile(file('clip.mp4', 'video/mp4')), false)
    assert.equal(isImageFile(file('mix.mp3', '')), false)
  })

  it('refuses SVG, which createImageBitmap cannot decode', () => {
    assert.equal(isImageFile(file('logo.svg', 'image/svg+xml')), false)
    assert.equal(isImageFile(file('logo.svg', '')), false)
  })

  it('gives a still a fixed default length from nowhere in the file', () => {
    assert.equal(IMAGE_DURATION, 5)
  })
})
