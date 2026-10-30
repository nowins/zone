#include "whisper.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// Only Zone's bounded 16 kHz mono PCM WAV format is accepted. Wide paths keep
// user data directories containing Chinese characters usable on Windows.
static void quiet(enum ggml_log_level, const char *, void *) {}
static FILE * progress_file = nullptr;
static size_t read_model(void * file, void * data, size_t size) { return fread(data, 1, size, (FILE *) file); }
static bool eof_model(void * file) { return feof((FILE *) file) != 0; }
static void close_model(void * file) { fclose((FILE *) file); }
static void progress(whisper_context *, whisper_state *, int value, void *) {
    if (progress_file) { fprintf(progress_file, "%d\n", std::clamp(value, 0, 100)); fflush(progress_file); }
}
static void json_string(FILE * file, const char * text) {
    fputc('"', file);
    for (const unsigned char * p = (const unsigned char *) text; *p; ++p) {
        if (*p == '"' || *p == '\\') { fputc('\\', file); fputc(*p, file); }
        else if (*p < 32) fprintf(file, "\\u%04x", *p);
        else fputc(*p, file);
    }
    fputc('"', file);
}
int wmain(int argc, wchar_t ** argv) {
    if (argc == 2 && wcscmp(argv[1], L"--version") == 0) {
        puts("zone-whisper/1 whisper.cpp/1.8.2 4979e04f5dcaccb36057e059bbaed8a2f5288315 cpu"); return 0;
    }
    if (argc != 7) return 2;
    std::unique_ptr<FILE, decltype(&fclose)> progress_output(_wfopen(argv[6], L"wb"), fclose);
    if (!progress_output) return 6;
    progress_file = progress_output.get();
    const int threads = _wtoi(argv[5]);
    if (threads < 1 || threads > 8) return 2;
    std::string language;
    if (wcscmp(argv[4], L"auto") == 0) language = "auto";
    else if (wcscmp(argv[4], L"en") == 0) language = "en";
    else if (wcscmp(argv[4], L"zh") == 0) language = "zh";
    else return 2;
    std::unique_ptr<FILE, decltype(&fclose)> input(_wfopen(argv[2], L"rb"), fclose);
    if (!input) return 3;
    unsigned char header[44];
    if (fread(header, 1, 44, input.get()) != 44 || memcmp(header, "RIFF", 4) ||
        memcmp(header + 8, "WAVEfmt ", 8) || memcmp(header + 36, "data", 4)) return 3;
    const auto u16 = [&](int i) { return unsigned(header[i]) | unsigned(header[i+1]) << 8; };
    const auto u32 = [&](int i) { return u16(i) | u16(i+2) << 16; };
    const unsigned bytes = u32(40);
    if (u32(16) != 16 || u16(20) != 1 || u16(22) != 1 || u32(24) != 16000 ||
        u16(34) != 16 || bytes == 0 || bytes % 2 || bytes > 60 * 32000) return 3;
    std::vector<short> pcm(bytes / 2);
    if (fread(pcm.data(), 1, bytes, input.get()) != bytes || fgetc(input.get()) != EOF) return 3;
    std::vector<float> samples(pcm.size());
    std::transform(pcm.begin(), pcm.end(), samples.begin(), [](short s) { return s / 32768.0f; });
    whisper_log_set(quiet, nullptr);
    FILE * model = _wfopen(argv[1], L"rb");
    if (!model) return 4;
    whisper_model_loader loader{model, read_model, eof_model, close_model};
    auto context_params = whisper_context_default_params();
    context_params.use_gpu = false;
    std::unique_ptr<whisper_context, decltype(&whisper_free)> context(whisper_init_with_params(&loader, context_params), whisper_free);
    if (!context) return 4;
    auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = threads;
    params.language = language.c_str();
    params.translate = false;
    params.no_context = true;
    params.print_realtime = params.print_progress = params.print_timestamps = params.print_special = false;
    params.progress_callback = progress;
    if (whisper_full(context.get(), params, samples.data(), (int) samples.size()) != 0) return 5;
    const int count = whisper_full_n_segments(context.get());
    if (count < 0 || count > 20000) return 5;
    std::unique_ptr<FILE, decltype(&fclose)> output(_wfopen(argv[3], L"wb"), fclose);
    if (!output) return 6;
    fputs("{\"segments\":[", output.get());
    for (int i = 0; i < count; ++i) {
        if (i) fputc(',', output.get());
        fprintf(output.get(), "{\"startTime\":%.3f,\"endTime\":%.3f,\"body\":",
            whisper_full_get_segment_t0(context.get(), i) / 100.0,
            whisper_full_get_segment_t1(context.get(), i) / 100.0);
        json_string(output.get(), whisper_full_get_segment_text(context.get(), i));
        fputc('}', output.get());
    }
    fputs("]}", output.get());
    return fflush(output.get()) == 0 && !ferror(output.get()) ? 0 : 6;
}
