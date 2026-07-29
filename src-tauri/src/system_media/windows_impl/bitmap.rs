use super::{Artwork, MediaIcon, PreviewState, TaskbarData};
use std::f32::consts::TAU;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{copy_nonoverlapping, null, null_mut};
use windows::core::{Error as WindowsError, HSTRING, Result as WindowsResult};
use windows::Win32::Foundation::{GENERIC_READ, HWND};
use windows::Win32::Graphics::Dwm::DwmSetIconicThumbnail;
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory, IWICPalette,
    WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, HICON, ICONINFO};

pub(super) fn load_artwork(path: &str) -> Option<Artwork> {
    let factory: IWICImagingFactory =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
            .ok()?;
    let filename = HSTRING::from(path);
    let decoder = unsafe {
        factory.CreateDecoderFromFilename(
            &filename,
            None,
            GENERIC_READ,
            WICDecodeMetadataCacheOnLoad,
        )
    }
    .ok()?;
    let frame = unsafe { decoder.GetFrame(0) }.ok()?;
    let converter = unsafe { factory.CreateFormatConverter() }.ok()?;
    unsafe {
        converter.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppBGRA,
            WICBitmapDitherTypeNone,
            None::<&IWICPalette>,
            0.0,
            WICBitmapPaletteTypeCustom,
        )
    }
    .ok()?;

    let mut width = 0;
    let mut height = 0;
    unsafe { converter.GetSize(&mut width, &mut height) }.ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    let stride = width.checked_mul(4)?;
    let byte_count = stride.checked_mul(height)? as usize;
    let mut bgra = vec![0; byte_count];
    unsafe { converter.CopyPixels(null(), stride, &mut bgra) }.ok()?;
    Some(Artwork {
        width,
        height,
        bgra,
    })
}

pub(super) unsafe fn provide_iconic_thumbnail(
    hwnd: HWND,
    data: &TaskbarData,
    max_width: u32,
    max_height: u32,
) {
    if max_width == 0 || max_height == 0 {
        return;
    }
    let Ok(preview) = data.preview.lock() else {
        return;
    };
    let Ok(bitmap) = preview_bitmap(&preview, max_width, max_height) else {
        return;
    };
    let _ = unsafe { DwmSetIconicThumbnail(hwnd, bitmap, 0) };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
    }
}

fn preview_bitmap(
    preview: &PreviewState,
    max_width: u32,
    max_height: u32,
) -> WindowsResult<HBITMAP> {
    let side = max_width.min(max_height).max(1);
    let bgra = if let Some(artwork) = &preview.artwork {
        resize_square_bgra(artwork, side)
    } else {
        let mut pixels = Vec::with_capacity((side * side * 4) as usize);
        for _ in 0..side * side {
            pixels.extend_from_slice(&[18, 18, 18, 255]);
        }
        pixels
    };
    create_bgra_bitmap(side, side, &bgra)
}

fn resize_square_bgra(artwork: &Artwork, side: u32) -> Vec<u8> {
    let crop_side = artwork.width.min(artwork.height);
    let crop_x = (artwork.width - crop_side) / 2;
    let crop_y = (artwork.height - crop_side) / 2;
    let scale = crop_side as f32 / side as f32;
    let mut output = Vec::with_capacity((side * side * 4) as usize);

    for target_y in 0..side {
        let source_y = (crop_y as f32 + (target_y as f32 + 0.5) * scale - 0.5)
            .clamp(crop_y as f32, (crop_y + crop_side - 1) as f32);
        let y0 = source_y.floor() as u32;
        let y1 = (y0 + 1).min(crop_y + crop_side - 1);
        let fy = source_y - y0 as f32;

        for target_x in 0..side {
            let source_x = (crop_x as f32 + (target_x as f32 + 0.5) * scale - 0.5)
                .clamp(crop_x as f32, (crop_x + crop_side - 1) as f32);
            let x0 = source_x.floor() as u32;
            let x1 = (x0 + 1).min(crop_x + crop_side - 1);
            let fx = source_x - x0 as f32;
            let mut pixel = [0u8; 4];

            for (channel, value) in pixel.iter_mut().enumerate() {
                let top = sample_channel(artwork, x0, y0, channel) * (1.0 - fx)
                    + sample_channel(artwork, x1, y0, channel) * fx;
                let bottom = sample_channel(artwork, x0, y1, channel) * (1.0 - fx)
                    + sample_channel(artwork, x1, y1, channel) * fx;
                *value = (top * (1.0 - fy) + bottom * fy).round() as u8;
            }

            let alpha = pixel[3] as u16;
            for channel in &mut pixel[..3] {
                *channel = ((*channel as u16 * alpha + 18 * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
            output.extend_from_slice(&pixel);
        }
    }
    output
}

fn sample_channel(artwork: &Artwork, x: u32, y: u32, channel: usize) -> f32 {
    artwork.bgra[((y * artwork.width + x) * 4) as usize + channel] as f32
}

pub(super) fn create_media_icon(kind: MediaIcon, size: u32) -> Result<HICON, String> {
    let alpha = rasterize_icon(kind, size);
    create_icon_from_alpha(size, &alpha).map_err(|error| error.to_string())
}

fn rasterize_icon(kind: MediaIcon, size: u32) -> Vec<u8> {
    const SUPERSAMPLE: u32 = 4;
    let high_size = size * SUPERSAMPLE;
    let unit = high_size as f32 / 16.0;
    let mut mask = vec![false; (high_size * high_size) as usize];

    match kind {
        MediaIcon::Previous => {
            fill_rect(&mut mask, high_size, 2.5, 3.5, 4.2, 12.5, unit);
            fill_triangle(
                &mut mask,
                high_size,
                [(4.5, 8.0), (12.2, 3.4), (12.2, 12.6)],
                unit,
            );
        }
        MediaIcon::Play => fill_triangle(
            &mut mask,
            high_size,
            [(4.2, 3.0), (13.0, 8.0), (4.2, 13.0)],
            unit,
        ),
        MediaIcon::Pause => {
            fill_rect(&mut mask, high_size, 4.0, 3.0, 7.0, 13.0, unit);
            fill_rect(&mut mask, high_size, 9.0, 3.0, 12.0, 13.0, unit);
        }
        MediaIcon::Next => {
            fill_triangle(
                &mut mask,
                high_size,
                [(3.8, 3.4), (11.5, 8.0), (3.8, 12.6)],
                unit,
            );
            fill_rect(&mut mask, high_size, 11.8, 3.5, 13.5, 12.5, unit);
        }
        MediaIcon::Favorite | MediaIcon::FavoriteFilled => {
            let heart = heart_points(unit);
            if matches!(kind, MediaIcon::FavoriteFilled) {
                fill_polygon(&mut mask, high_size, &heart);
            } else {
                for points in heart.windows(2) {
                    draw_line(&mut mask, high_size, points[0], points[1], 1.45 * unit);
                }
            }
        }
    }

    let mut alpha = vec![0u8; (size * size) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut coverage = 0u32;
            for sample_y in 0..SUPERSAMPLE {
                for sample_x in 0..SUPERSAMPLE {
                    let high_x = x * SUPERSAMPLE + sample_x;
                    let high_y = y * SUPERSAMPLE + sample_y;
                    if mask[(high_y * high_size + high_x) as usize] {
                        coverage += 1;
                    }
                }
            }
            alpha[(y * size + x) as usize] =
                (coverage * 255 / (SUPERSAMPLE * SUPERSAMPLE)) as u8;
        }
    }
    alpha
}

fn heart_points(unit: f32) -> Vec<(f32, f32)> {
    let mut points = Vec::with_capacity(66);
    for index in 0..=64 {
        let angle = TAU * index as f32 / 64.0;
        let x = 8.0 + 0.32 * 16.0 * angle.sin().powi(3);
        let y = 8.0
            - 0.29
                * (13.0 * angle.cos()
                    - 5.0 * (2.0 * angle).cos()
                    - 2.0 * (3.0 * angle).cos()
                    - (4.0 * angle).cos());
        points.push((x * unit, y * unit));
    }
    points
}

fn fill_rect(
    mask: &mut [bool],
    size: u32,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    unit: f32,
) {
    let left = (left * unit).floor().max(0.0) as u32;
    let top = (top * unit).floor().max(0.0) as u32;
    let right = (right * unit).ceil().min(size as f32) as u32;
    let bottom = (bottom * unit).ceil().min(size as f32) as u32;
    for y in top..bottom {
        for x in left..right {
            mask[(y * size + x) as usize] = true;
        }
    }
}

fn fill_triangle(mask: &mut [bool], size: u32, points: [(f32, f32); 3], unit: f32) {
    let points = points.map(|(x, y)| (x * unit, y * unit));
    for y in 0..size {
        for x in 0..size {
            let point = (x as f32 + 0.5, y as f32 + 0.5);
            let a = edge(points[0], points[1], point);
            let b = edge(points[1], points[2], point);
            let c = edge(points[2], points[0], point);
            if (a >= 0.0 && b >= 0.0 && c >= 0.0) || (a <= 0.0 && b <= 0.0 && c <= 0.0) {
                mask[(y * size + x) as usize] = true;
            }
        }
    }
}

fn fill_polygon(mask: &mut [bool], size: u32, points: &[(f32, f32)]) {
    for y in 0..size {
        for x in 0..size {
            let point = (x as f32 + 0.5, y as f32 + 0.5);
            let mut inside = false;
            for index in 0..points.len() - 1 {
                let (x1, y1) = points[index];
                let (x2, y2) = points[index + 1];
                if (y1 > point.1) != (y2 > point.1)
                    && point.0 < (x2 - x1) * (point.1 - y1) / (y2 - y1) + x1
                {
                    inside = !inside;
                }
            }
            if inside {
                mask[(y * size + x) as usize] = true;
            }
        }
    }
}

fn draw_line(mask: &mut [bool], size: u32, start: (f32, f32), end: (f32, f32), width: f32) {
    let radius_squared = (width * 0.5).powi(2);
    let segment = (end.0 - start.0, end.1 - start.1);
    let length_squared = segment.0 * segment.0 + segment.1 * segment.1;
    for y in 0..size {
        for x in 0..size {
            let point = (x as f32 + 0.5, y as f32 + 0.5);
            let projection = if length_squared > 0.0 {
                (((point.0 - start.0) * segment.0 + (point.1 - start.1) * segment.1)
                    / length_squared)
                    .clamp(0.0, 1.0)
            } else {
                0.0
            };
            let nearest = (
                start.0 + projection * segment.0,
                start.1 + projection * segment.1,
            );
            let distance_squared =
                (point.0 - nearest.0).powi(2) + (point.1 - nearest.1).powi(2);
            if distance_squared <= radius_squared {
                mask[(y * size + x) as usize] = true;
            }
        }
    }
}

fn edge(start: (f32, f32), end: (f32, f32), point: (f32, f32)) -> f32 {
    (point.0 - start.0) * (end.1 - start.1) - (point.1 - start.1) * (end.0 - start.0)
}

fn create_icon_from_alpha(size: u32, alpha: &[u8]) -> WindowsResult<HICON> {
    let mut bgra = Vec::with_capacity((size * size * 4) as usize);
    for alpha in alpha {
        bgra.extend_from_slice(&[*alpha, *alpha, *alpha, *alpha]);
    }
    let color = create_bgra_bitmap(size, size, &bgra)?;
    let mask_stride = ((size + 15) / 16) * 2;
    let mask_bits = vec![0u8; (mask_stride * size) as usize];
    let mask = unsafe {
        CreateBitmap(
            size as i32,
            size as i32,
            1,
            1,
            Some(mask_bits.as_ptr() as *const c_void),
        )
    };
    if mask.is_invalid() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(color.0));
        }
        return Err(WindowsError::from_win32());
    }

    let icon_info = ICONINFO {
        fIcon: true.into(),
        hbmMask: mask,
        hbmColor: color,
        ..Default::default()
    };
    let icon = unsafe { CreateIconIndirect(&icon_info) };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    icon
}

fn create_bgra_bitmap(width: u32, height: u32, pixels: &[u8]) -> WindowsResult<HBITMAP> {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: width * height * 4,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = null_mut();
    let bitmap = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
    unsafe {
        copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
    }
    Ok(bitmap)
}
