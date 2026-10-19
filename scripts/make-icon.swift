// 应用图标处理：裁剪生成图中心安全区 → 缩放至目标尺寸 → 叠加 macOS Big Sur 规范圆角 alpha 遮罩
// 用法: swift scripts/make-icon.swift <input> <output> [size] [radius] [cropX cropY cropW cropH]
// 依赖 macOS 自带 Command Line Tools（CoreGraphics / ImageIO），无需第三方图像库
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// swift 解释执行时 argv 是编译器完整参数，用户参数位于 "--" 之后；编译后执行则跳过程序名
let raw = CommandLine.arguments
let args: [String]
if let sep = raw.firstIndex(of: "--") {
    args = Array(raw[raw.index(after: sep)...])
} else {
    args = Array(raw.dropFirst())
}
guard args.count >= 3 else {
    print("usage: swift make-icon.swift <input> <output> [size] [radius] [cropX cropY cropW cropH]")
    exit(1)
}
let input = args[0]
let output = args[1]
let size = args.count > 2 ? Int(args[2]) ?? 1024 : 1024
let radius = args.count > 3 ? Int(args[3]) ?? 185 : 185
let hasCrop = args.count >= 7
let cropRect: CGRect?
if hasCrop {
    guard let x = Double(args[4]), let y = Double(args[5]),
          let w = Double(args[6]), let h = Double(args[7]) else {
        print("ERROR: bad crop args: \(args)")
        exit(1)
    }
    cropRect = CGRect(x: x, y: y, width: w, height: h)
} else {
    cropRect = nil
}

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let full = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    print("ERROR: cannot load \(input)")
    exit(1)
}
let img = cropRect.map { full.cropping(to: $0) } ?? full
guard let cropped = img else { print("ERROR: crop failed"); exit(2) }

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
let rect = CGRect(x: 0, y: 0, width: size, height: size)

// 圆角矩形裁剪路径（对称图形，坐标系方向不影响结果）
ctx.addPath(CGPath(roundedRect: rect, cornerWidth: CGFloat(radius), cornerHeight: CGFloat(radius), transform: nil))
ctx.clip()
ctx.interpolationQuality = .high

// CGContext 原点在左下，位图坐标系原点在左上：翻转后绘制避免上下颠倒
ctx.saveGState()
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)
ctx.draw(cropped, in: rect)
ctx.restoreGState()

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: output) as CFURL,
        UTType.png.identifier as CFString, 1, nil
      ) else {
    print("ERROR: cannot write \(output)")
    exit(3)
}
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
print("OK \(output) \(size)x\(size) radius=\(radius)")
