import fileType from 'file-type';

import { PNG } from 'pngjs';
import JPEG from 'jpeg-js';
import BMP from 'bmp-js';
import UTIF from 'utif';
import EXIFParser from 'exif-parser';
import GIF from 'omggif';

import * as constants from '../constants';
import { toAGBR, fromAGBR } from './abgr';
import { throwError } from './error-checking';
import * as MIME from './mime';
import promisify from './promisify';

function getMIMEFromBuffer(buffer, path) {
    const fileTypeFromBuffer = fileType(buffer);

    if (fileTypeFromBuffer) {
        // If fileType returns something for buffer, then return the mime given
        return fileTypeFromBuffer.mime;
    }

    if (path) {
        // If a path is supplied, and fileType yields no results, then retry with MIME
        // Path can be either a file path or a url
        return MIME.getType(path);
    }

    return null;
}

// gets image data from a GIF buffer
function getBitmapFromGIF(data) {
    const gifObj = new GIF.GifReader(data);
    const gifData = Buffer.alloc(gifObj.width * gifObj.height * 4);

    gifObj.decodeAndBlitFrameRGBA(0, gifData);

    return {
        data: gifData,
        width: gifObj.width,
        height: gifObj.height
    };
}

/*
 * Automagically rotates an image based on its EXIF data (if present)
 * @param img a constants object
*/
function exifRotate(img) {
    const exif = img._exif;

    if (exif && exif.tags && exif.tags.Orientation) {
        switch (img._exif.tags.Orientation) {
            case 1: // Horizontal (normal)
                // do nothing
                break;
            case 2: // Mirror horizontal
                img.mirror(true, false);
                break;
            case 3: // Rotate 180
                img.rotate(180, false);
                break;
            case 4: // Mirror vertical
                img.mirror(false, true);
                break;
            case 5: // Mirror horizontal and rotate 270 CW
                img.rotate(-90, false).mirror(true, false);
                break;
            case 6: // Rotate 90 CW
                img.rotate(-90, false);
                break;
            case 7: // Mirror horizontal and rotate 90 CW
                img.rotate(90, false).mirror(true, false);
                break;
            case 8: // Rotate 270 CW
                img.rotate(-270, false);
                break;
            default:
                break;
        }
    }

    return img;
}

// parses a bitmap from the constructor to the JIMP bitmap property
export function parseBitmap(data, path, cb) {
    const mime = getMIMEFromBuffer(data, path);

    if (typeof mime !== 'string') {
        return cb(new Error('Could not find MIME for Buffer <' + path + '>'));
    }

    this._originalMime = mime.toLowerCase();

    try {
        switch (this.getMIME()) {
            case constants.MIME_PNG: {
                const png = PNG.sync.read(data);

                this.bitmap = {
                    data: Buffer.from(png.data),
                    width: png.width,
                    height: png.height
                };

                break;
            }

            case constants.MIME_JPEG:
                this.bitmap = JPEG.decode(data);

                try {
                    this._exif = EXIFParser.create(data).parse();
                    exifRotate(this); // EXIF data
                } catch (err) {
                    /* meh */
                }

                break;

            case constants.MIME_TIFF: {
                const ifds = UTIF.decode(data);
                const page = ifds[0];
                UTIF.decodeImages(data, ifds);
                const rgba = UTIF.toRGBA8(page);

                this.bitmap = {
                    data: Buffer.from(rgba),
                    width: page.t256[0],
                    height: page.t257[0]
                };

                break;
            }

            case constants.MIME_BMP:
            case constants.MIME_X_MS_BMP:
                try {
                    this.bitmap = BMP.decode(data);

                    fromAGBR(this);
                } catch (e) {}
                break;

            case constants.MIME_GIF:
                this.bitmap = getBitmapFromGIF(data);
                break;

            default:
                return throwError.call(
                    this,
                    'Unsupported MIME type: ' + mime,
                    cb
                );
        }
    } catch (error) {
        cb.call(this, error, this);
    }

    cb.call(this, null, this);

    return this;
}

function compositeBitmapOverBackground(Jimp, image) {
    return new Jimp(
        image.bitmap.width,
        image.bitmap.height,
        image._background
    ).composite(image, 0, 0).bitmap;
}

/**
 * Converts the image to a buffer
 * @param {string} mime the mime type of the image buffer to be created
 * @param {function(Error, Jimp)} cb a Node-style function to call with the buffer as the second argument
 * @returns {Jimp} this for chaining of methods
 */
export function getBuffer(mime, cb) {
    if (mime === constants.AUTO) {
        // allow auto MIME detection
        mime = this.getMIME();
    }

    if (typeof mime !== 'string') {
        return throwError.call(this, 'mime must be a string', cb);
    }

    if (typeof cb !== 'function') {
        return throwError.call(this, 'cb must be a function', cb);
    }

    switch (mime.toLowerCase()) {
        case constants.MIME_PNG: {
            const png = new PNG({
                width: this.bitmap.width,
                height: this.bitmap.height,
                bitDepth: 8,
                deflateLevel: this._deflateLevel,
                deflateStrategy: this._deflateStrategy,
                filterType: this._filterType,
                colorType: this._rgba ? 6 : 2,
                inputHasAlpha: true
            });

            if (this._rgba) {
                png.data = Buffer.from(this.bitmap.data);
            } else {
                // when PNG doesn't support alpha
                png.data = compositeBitmapOverBackground(
                    this.constructor,
                    this
                ).data;
            }

            const buffer = PNG.sync.write(png);
            cb.call(this, null, buffer);
            break;
        }

        case constants.MIME_JPEG: {
            // composite onto a new image so that the background shows through alpha channels
            const jpeg = JPEG.encode(
                compositeBitmapOverBackground(this.constructor, this),
                this._quality
            );
            cb.call(this, null, jpeg.data);
            break;
        }

        case constants.MIME_BMP:
        case constants.MIME_X_MS_BMP: {
            // composite onto a new image so that the background shows through alpha channels
            toAGBR(this);

            const bmp = BMP.encode(
                compositeBitmapOverBackground(this.constructor, this)
            );
            cb.call(this, null, bmp.data);
            break;
        }

        case constants.MIME_TIFF: {
            const c = compositeBitmapOverBackground(this.constructor, this);
            const tiff = UTIF.encodeImage(c.data, c.width, c.height);
            cb.call(this, null, Buffer.from(tiff));
            break;
        }

        default:
            cb.call(this, 'Unsupported MIME type: ' + mime);
            break;
    }

    return this;
}

export function getBufferAsync(mime) {
    return promisify(getBuffer, this, mime);
}
