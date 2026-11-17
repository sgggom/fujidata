# fujidata

富士照片 EXIF / MakerNote 读取器，所有解析在浏览器本地完成。

## 手机相册读取诊断

- 标准 EXIF 使用固定版本的 exifr 7.1.3。
- JPEG 和经典 TIFF（包括相同结构的 DNG）会额外直接遍历 EXIF IFD 的 `0x927C` MakerNote 标签，不依赖 exifr 的输出。如果存在有效的 `FUJIFILM` 数据，会直接解码。
- RAF 检查范围为内嵌 JPEG 预览，不代表检查了整个 RAW 容器的所有元数据。
- JPEG 检查标记范围截止首次 SOS / EOI，不扫描压缩像素，也不会把任意位置的 `FUJIFILM` 字符串当作标签。
- HEIC、PNG、BigTIFF 等不支持直接检查的结构，不会被诊断为“确认没有 MakerNote”；仍保留 exifr 读取路径。
- JSON 导出的 `_metadataDiagnostic` 包含检查状态、输入文件大小与类型、MakerNote 长度/偏移/头部、解码来源与警告。不会包含完整 MakerNote 二进制或照片像素。JSON 本身仍可能包含拍摄时间、位置、序列号等个人信息，分享前请检查。

相册选择器交付给网页的文件可能与相册原图不同。若网页收到的数据确实未携带 MakerNote，JavaScript 无法凭空恢复；可使用同一原图从“文件”入口对照。当前实现不代表已确认或修复特定 iOS 版本的系统问题。

## 测试

需要 Node.js 18 或更新版本，无需安装测试依赖：

```sh
node --test tests/*.test.cjs
```
