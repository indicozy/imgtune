// imgtune-ssimu2-gpu: SSIMULACRA2 on an NVIDIA GPU through libvship (Vship, https://codeberg.org/Line-fr/Vship).
// imgtune starts this program for `--gpu`. It is not needed otherwise. Vship is not bundled: build libvship for your GPU
// as Vship documents, then build this file against it:
//
//   g++ -std=c++17 -O2 -I <vship>/src imgtune-ssimu2-gpu.cpp -L <vship> -Wl,-rpath,<vship> -lvship -o imgtune-ssimu2-gpu
//
// Usage:
//   imgtune-ssimu2-gpu --check [--device N]   score an identical and a perturbed pair, print one JSON line, exit 0
//   imgtune-ssimu2-gpu [--device N]           serve requests on stdin, answer on stdout, until stdin closes
//
// --device N is the index of the GPU in this process's own view (CUDA's numbering: fastest first unless the environment sets
// CUDA_DEVICE_ORDER=PCI_BUS_ID). imgtune sets CUDA_VISIBLE_DEVICES itself only when the user has not, and then N is 0; a
// user's CUDA_VISIBLE_DEVICES is kept and N indexes the devices it lists. Frames are little-endian.
//   request:  u32 count (1..256); then count pairs of: u32 width, u32 height, width*height*3 bytes of reference
//             RGB (8-bit, interleaved, sRGB), then width*height*3 bytes of test RGB.
//   response: u32 status. 0: count x f64 scores follow (SSIMULACRA2, 100 = identical; scores can be negative).
//             otherwise: u32 length and a UTF-8 message; the process exits after sending it.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include "VshipAPI.h"
#include "VshipColor.h"

namespace {

constexpr uint32_t kMaxCount = 256;
constexpr uint64_t kMaxPixels = 16ull * 1024 * 1024;
constexpr size_t kMaxHandlers = 4;

struct Pair {
  uint32_t width = 0, height = 0;
  std::vector<uint8_t> ref, test; // interleaved RGB
};

[[noreturn]] void fail(const std::string& message) {
  std::fprintf(stderr, "imgtune-ssimu2-gpu: %s\n", message.c_str());
  std::exit(1);
}

std::string lastError(const char* what, Vship_Exception e) {
  char msg[1024] = {0};
  Vship_GetDetailedLastError(msg, sizeof msg);
  return std::string(what) + " failed (code " + std::to_string((int)e) + "): " + msg;
}

bool readExact(void* buf, size_t n) {
  return n == 0 || std::fread(buf, 1, n, stdin) == n;
}

bool readU32(uint32_t& v) {
  uint8_t b[4];
  if (!readExact(b, 4)) return false;
  v = (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
  return true;
}

void writeBytes(const void* p, size_t n) {
  std::fwrite(p, 1, n, stdout);
}

void writeU32(uint32_t v) {
  uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)};
  writeBytes(b, 4);
}

// The host is little-endian on every platform this builds for, so doubles go out as their bytes.
void writeF64(double v) {
  writeBytes(&v, sizeof v);
}

Vship_Colorspace_t rgbSpace(uint32_t w, uint32_t h) {
  Vship_Colorspace_t cs{};
  cs.width = w;
  cs.height = h;
  cs.target_width = -1;
  cs.target_height = -1;
  cs.sample = Vship_SampleUINT8;
  cs.range = Vship_RangeFull;
  cs.subsampling = {0, 0};
  cs.colorFamily = Vship_ColorRGB;
  cs.YUVMatrix = Vship_MATRIX_RGB;
  cs.transferFunction = Vship_TRC_sRGB;
  cs.primaries = Vship_PRIMARIES_BT709;
  return cs;
}

// One SSIMULACRA2 handler per image size, kept for the process lifetime (a handler is sized by the image).
class Scorer {
 public:
  explicit Scorer(int gpu) : gpu_(gpu) {}
  ~Scorer() {
    for (auto& entry : handlers_) Vship_SSIMU2Free(entry.second);
  }

  // Sets value and returns true, or sets error and returns false. (SSIMULACRA2 can be negative, so no sentinel.)
  bool score(const Pair& p, double& value, std::string& error) {
    Vship_SSIMU2Handler h{};
    if (!handlerFor(p.width, p.height, h, error)) return false;
    std::vector<uint8_t> ref[3], test[3];
    planes(p.ref, p.width, p.height, ref);
    planes(p.test, p.width, p.height, test);
    const uint8_t* rp[3] = {ref[0].data(), ref[1].data(), ref[2].data()};
    const uint8_t* tp[3] = {test[0].data(), test[1].data(), test[2].data()};
    const int64_t stride[3] = {p.width, p.width, p.width};
    Vship_Exception e = Vship_ComputeSSIMU2(h, &value, rp, tp, stride, stride);
    if (e != 0) {
      char msg[1024] = {0};
      Vship_SSIMU2GetDetailedLastError(h, msg, sizeof msg);
      error = std::string("score failed (code ") + std::to_string((int)e) + "): " + msg;
      return false;
    }
    return true;
  }

 private:
  using Key = std::pair<uint32_t, uint32_t>;

  bool handlerFor(uint32_t w, uint32_t h, Vship_SSIMU2Handler& out, std::string& error) {
    const Key key(w, h);
    auto it = handlers_.find(key);
    if (it != handlers_.end()) {
      out = it->second;
      return true;
    }
    if (handlers_.size() >= kMaxHandlers) {
      Vship_SSIMU2Free(handlers_[order_.front()]);
      handlers_.erase(order_.front());
      order_.erase(order_.begin());
    }
    Vship_Colorspace_t cs = rgbSpace(w, h);
    Vship_Exception e = Vship_SSIMU2Init2(&out, cs, cs, gpu_);
    if (e != 0) {
      error = lastError("handler init", e);
      return false;
    }
    handlers_[key] = out;
    order_.push_back(key);
    return true;
  }

  // Interleaved RGB to the three planes Vship reads.
  static void planes(const std::vector<uint8_t>& rgb, uint32_t w, uint32_t h, std::vector<uint8_t> out[3]) {
    const size_t n = (size_t)w * h;
    for (int c = 0; c < 3; c++) out[c].resize(n);
    for (size_t i = 0; i < n; i++) {
      out[0][i] = rgb[i * 3];
      out[1][i] = rgb[i * 3 + 1];
      out[2][i] = rgb[i * 3 + 2];
    }
  }

  int gpu_;
  std::map<Key, Vship_SSIMU2Handler> handlers_;
  std::vector<Key> order_; // oldest first
};

int parseDevice(int argc, char** argv) {
  for (int i = 1; i + 1 < argc; i++) {
    if (std::strcmp(argv[i], "--device") == 0) return std::atoi(argv[i + 1]);
  }
  return 0;
}

int check(int gpu) {
  Vship_DeviceInfo info{};
  Vship_Exception e = Vship_GetDeviceInfo(&info, gpu);
  if (e != 0) fail(lastError("device info", e));
  e = Vship_GPUFullCheck(gpu);
  if (e != 0) fail(lastError("GPU check", e));
  const uint32_t w = 64, h = 64;
  Pair same, changed;
  same.width = changed.width = w;
  same.height = changed.height = h;
  same.ref.resize(w * h * 3);
  for (size_t i = 0; i < same.ref.size(); i++) same.ref[i] = (uint8_t)((i * 37) & 255);
  same.test = same.ref;
  changed.ref = same.ref;
  changed.test = same.ref;
  for (size_t i = 0; i < changed.test.size(); i += 3) changed.test[i] ^= 0x10;
  std::string error;
  Scorer scorer(gpu);
  double a = 0, b = 0;
  if (!scorer.score(same, a, error)) fail(error);
  if (!scorer.score(changed, b, error)) fail(error);
  std::printf("{\"device\":\"%s\",\"identical\":%.6f,\"perturbed\":%.6f}\n", info.name, a, b);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  const int gpu = parseDevice(argc, argv);
  if (argc > 1 && std::strcmp(argv[1], "--check") == 0) return check(gpu);
  Vship_Exception e = Vship_GPUFullCheck(gpu);
  if (e != 0) fail(lastError("GPU check", e));

  Scorer scorer(gpu);
  for (;;) {
    uint32_t count = 0;
    if (!readU32(count)) return 0; // stdin closed: done
    std::string error;
    if (count == 0 || count > kMaxCount) error = "bad request count " + std::to_string(count);
    std::vector<Pair> pairs;
    for (uint32_t k = 0; error.empty() && k < count; k++) {
      Pair p;
      if (!readU32(p.width) || !readU32(p.height)) fail("truncated request");
      const uint64_t n = (uint64_t)p.width * p.height;
      if (p.width < 8 || p.height < 8 || n > kMaxPixels) {
        error = "bad image size " + std::to_string(p.width) + "x" + std::to_string(p.height);
        break;
      }
      p.ref.resize(n * 3);
      p.test.resize(n * 3);
      if (!readExact(p.ref.data(), p.ref.size()) || !readExact(p.test.data(), p.test.size())) fail("truncated request");
      pairs.push_back(std::move(p));
    }
    std::vector<double> scores;
    for (size_t k = 0; error.empty() && k < pairs.size(); k++) {
      double s = 0;
      if (scorer.score(pairs[k], s, error)) scores.push_back(s);
    }
    if (!error.empty()) {
      writeU32(1);
      writeU32((uint32_t)error.size());
      writeBytes(error.data(), error.size());
      std::fflush(stdout);
      return 1;
    }
    writeU32(0);
    for (double s : scores) writeF64(s);
    std::fflush(stdout);
  }
}
