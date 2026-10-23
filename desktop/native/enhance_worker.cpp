// One model per task. RGB24 frames enter stdin and leave stdout; logs use stderr.
#include "realesrgan.h"
#include "cpu.h"
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static std::string json_string(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out += '\\';
        if (c >= 32) out += c;
    }
    return out + '"';
}
static int integer(const std::string& value) {
    size_t used = 0;
    int number = std::stoi(value, &used);
    if (used != value.size()) throw std::runtime_error("Invalid integer argument");
    return number;
}
struct VulkanInstance {
    VulkanInstance() { ncnn::create_gpu_instance(); }
    ~VulkanInstance() { ncnn::destroy_gpu_instance(); }
};
int main(int argc, char** argv) {
    std::signal(SIGPIPE, SIG_IGN);
    try {
        int width = 0, height = 0, scale = 2, tile = 0, gpu = -1, winograd = -1;
        bool probe = false;
        std::string model_dir;
        for (int i = 1; i < argc; ++i) {
            std::string key = argv[i];
            if (key == "--probe") { probe = true; continue; }
            if (i + 1 == argc) throw std::runtime_error("Missing argument value");
            std::string value = argv[++i];
            if (key == "--width") width = integer(value);
            else if (key == "--height") height = integer(value);
            else if (key == "--scale") scale = integer(value);
            else if (key == "--tile") tile = integer(value);
            else if (key == "--gpu") gpu = integer(value);
            else if (key == "--winograd") winograd = integer(value);
            else if (key == "--model-dir") model_dir = value;
            else throw std::runtime_error("Unknown argument: " + key);
        }
        if (!probe && (width < 1 || height < 1 || width > 8192 || height > 8192 ||
            scale < 2 || scale > 4 || width * scale > 16384 || height * scale > 16384 ||
            tile < 0 || tile > 2048 || (tile != 0 && tile < 32) || winograd < -1 || winograd > 1))
            throw std::runtime_error("Invalid frame dimensions, scale or tile");
        VulkanInstance instance;
        if (gpu == -1) gpu = ncnn::get_default_gpu_index();
        if (gpu < 0 || gpu >= ncnn::get_gpu_count()) throw std::runtime_error("No compatible Vulkan GPU");
        const auto* device = ncnn::get_gpu_device(gpu);
        const std::string name = ncnn::get_gpu_info(gpu).device_name();
        if (probe) {
            std::cout << "{\"protocol\":1,\"engine\":\"ncnn-vulkan-stream\",\"device\":" << json_string(name) << "}\n";
            return 0;
        }
        const std::string base = "realesr-animevideov3-x" + std::to_string(scale);
        const fs::path param = fs::path(model_dir) / (base + ".param");
        const fs::path weights = fs::path(model_dir) / (base + ".bin");
        if (!fs::is_regular_file(param) || !fs::is_regular_file(weights) || fs::file_size(weights) < 1024)
            throw std::runtime_error("Real-ESRGAN model files are missing");
        if (tile == 0) {
            const auto budget = device->get_heap_budget();
            tile = budget >= 4000 ? 512 : budget >= 1400 ? 256 : budget >= 400 ? 128 : 64;
        }
        ncnn::set_omp_num_threads(2);
        const auto& info = ncnn::get_gpu_info(gpu);
        const bool fp16 = info.support_fp16_arithmetic();
        const bool use_winograd = winograd == -1 ? !(info.vendor_id() == 0x8086 && fp16 && info.support_cooperative_matrix()) : winograd != 0;
        RealESRGAN model(gpu, false, fp16, use_winograd);
        model.scale = scale;
        model.tilesize = tile;
        model.prepadding = 10;
        if (model.load(param.string(), weights.string()) != 0) throw std::runtime_error("Cannot load Real-ESRGAN");
        std::cerr << "LINGO {\"event\":\"ready\",\"modelLoads\":1,\"tile\":" << tile
                  << ",\"precision\":" << json_string(fp16 ? "fp16" : "fp32")
                  << ",\"convolution\":" << json_string(use_winograd ? "winograd" : "gemm")
                  << ",\"device\":" << json_string(name) << "}\n" << std::flush;
        const size_t bytes = static_cast<size_t>(width) * height * 3;
        std::vector<unsigned char> input(bytes);
        ncnn::Mat output(width * scale, height * scale, static_cast<size_t>(3), 3);
        if (output.empty()) throw std::runtime_error("Cannot allocate output frame");
        size_t frames = 0;
        while (true) {
            size_t received = 0;
            while (received < bytes) {
                const size_t n = std::fread(input.data() + received, 1, bytes - received, stdin);
                if (n == 0) break;
                received += n;
            }
            if (received == 0 && std::feof(stdin)) break;
            if (received != bytes) throw std::runtime_error("Truncated RGB input frame");
            ncnn::Mat image(width, height, input.data(), static_cast<size_t>(3), 3);
            if (model.process(image, output) != 0) throw std::runtime_error("Real-ESRGAN inference failed");
            const size_t out_bytes = bytes * scale * scale;
            if (std::fwrite(output.data, 1, out_bytes, stdout) != out_bytes || std::fflush(stdout) != 0)
                throw std::runtime_error("Video encoder closed the frame stream");
            ++frames;
            std::cerr << "LINGO {\"event\":\"frame\",\"done\":" << frames << "}\n" << std::flush;
        }
        if (frames == 0) throw std::runtime_error("No video frames received");
        std::cerr << "LINGO {\"event\":\"complete\",\"frames\":" << frames << ",\"modelLoads\":1}\n" << std::flush;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Enhancement: " << error.what() << '\n';
        return 1;
    }
}
