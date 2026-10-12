/* RadioDesk FT8/FT4 bridge, MIT. GFSK synthesis adapted from kgoba/ft8_lib demo/gen_ft8.c (MIT). */
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <ft8/message.h>
#include <ft8/encode.h>
#include <ft8/decode.h>
#include <ft8/constants.h>
#include <common/monitor.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define RD_MAX_RESULTS 80
#define RD_MAX_CANDIDATES 240

typedef struct { char text[FTX_MAX_MESSAGE_LENGTH + 1]; float frequency; float time; int score; uint8_t payload[10]; } rd_result_t;
static rd_result_t results[RD_MAX_RESULTS];
static int result_count = 0;

/* A bounded callsign cache allows type-4 / hashed-call decoding across slots. */
typedef struct { char call[12]; uint32_t hash; } rd_call_t;
static rd_call_t calls[256];
static int next_call = 0;
static void save_call(const char* call, uint32_t hash) {
    for (int i = 0; i < 256; ++i) if (calls[i].call[0] && calls[i].hash == hash && strcmp(calls[i].call, call) == 0) return;
    strncpy(calls[next_call].call, call, 11); calls[next_call].call[11] = 0; calls[next_call].hash = hash;
    next_call = (next_call + 1) % 256;
}
static bool lookup_call(ftx_callsign_hash_type_t type, uint32_t hash, char* call) {
    int shift = type == FTX_CALLSIGN_HASH_10_BITS ? 12 : type == FTX_CALLSIGN_HASH_12_BITS ? 10 : 0;
    for (int i = 0; i < 256; ++i) if (calls[i].call[0] && (calls[i].hash >> shift) == hash) { strcpy(call, calls[i].call); return true; }
    call[0] = 0; return false;
}
static ftx_callsign_hash_interface_t hash_interface = { .lookup_hash = lookup_call, .save_hash = save_call };

void rd_reset(void) { memset(calls, 0, sizeof(calls)); next_call = result_count = 0; }

int rd_encode(const char* text, int mode, int free_text, uint8_t* payload, uint8_t* tones, char* normalized) {
    if (mode != 4 && mode != 8) return -100;
    ftx_message_t message;
    ftx_message_init(&message);
    ftx_message_rc_t status = free_text ? ftx_message_encode_free(&message, text) : ftx_message_encode(&message, &hash_interface, text);
    if (status != FTX_MESSAGE_RC_OK) return -(int)status - 1;
    ftx_message_offsets_t offsets;
    if (ftx_message_decode(&message, &hash_interface, normalized, &offsets) != FTX_MESSAGE_RC_OK) return -101;
    memcpy(payload, message.payload, 10);
    if (mode == 4) { ft4_encode(payload, tones); return FT4_NN; }
    ft8_encode(payload, tones); return FT8_NN;
}

/* Shape the phase-continuous tone stream with FT8 BT=2 / FT4 BT=1 pulses. */
int rd_synthesize(const uint8_t* tones, int mode, float base_hz, int sample_rate, float volume, float* output) {
    if (mode != 4 && mode != 8) return -1;
    int count = mode == 4 ? FT4_NN : FT8_NN;
    float period = mode == 4 ? FT4_SYMBOL_PERIOD : FT8_SYMBOL_PERIOD;
    float bt = mode == 4 ? 1.0f : 2.0f;
    int sps = (int)(sample_rate * period + 0.5f), length = count * sps;
    if (sps < 1) return -1;
    float* phase_steps = malloc((length + 2 * sps) * sizeof(float));
    float* pulse = malloc(3 * sps * sizeof(float));
    if (!phase_steps || !pulse) { free(phase_steps); free(pulse); return -2; }
    const float carrier_step = 2.0f * M_PI * base_hz / sample_rate;
    for (int i = 0; i < length + 2 * sps; ++i) phase_steps[i] = carrier_step;
    for (int i = 0; i < 3 * sps; ++i) {
        float t = (float)i / sps - 1.5f;
        pulse[i] = (erff(5.336446f * bt * (t + 0.5f)) - erff(5.336446f * bt * (t - 0.5f))) / 2;
    }
    const float deviation_step = 2.0f * M_PI / sps;
    for (int symbol = 0; symbol < count; ++symbol) for (int j = 0; j < 3 * sps; ++j) phase_steps[symbol * sps + j] += deviation_step * tones[symbol] * pulse[j];
    for (int j = 0; j < 2 * sps; ++j) {
        phase_steps[j] += deviation_step * pulse[j + sps] * tones[0];
        phase_steps[j + count * sps] += deviation_step * pulse[j] * tones[count - 1];
    }
    float phase = 0;
    for (int i = 0; i < length; ++i) { output[i] = volume * sinf(phase); phase = fmodf(phase + phase_steps[i + sps], 2.0f * M_PI); }
    int ramp = sps / 8;
    for (int i = 0; i < ramp; ++i) { float envelope = (1 - cosf(M_PI * i / ramp)) / 2; output[i] *= envelope; output[length - 1 - i] *= envelope; }
    free(phase_steps); free(pulse); return length;
}

/* Input is mono 12 kHz PCM covering one slot. A positive count means CRC-verified decodes. */
int rd_decode(const float* samples, int count, int mode) {
    result_count = 0;
    if (mode != 4 && mode != 8) return -1;
    int slot_count = mode == 4 ? 90000 : 180000;
    if (count < 1 || count > slot_count) return -2;
    monitor_config_t configuration = { .f_min = 200, .f_max = 3000, .sample_rate = 12000, .time_osr = 2, .freq_osr = 2, .protocol = mode == 4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8 };
    monitor_t monitor;
    monitor_init(&monitor, &configuration);
    for (int position = 0; position + monitor.block_size <= count; position += monitor.block_size) monitor_process(&monitor, samples + position);
    ftx_candidate_t candidates[RD_MAX_CANDIDATES];
    int candidate_count = ftx_find_candidates(&monitor.wf, RD_MAX_CANDIDATES, candidates, 10);
    for (int i = 0; i < candidate_count && result_count < RD_MAX_RESULTS; ++i) {
        ftx_message_t message; ftx_decode_status_t status;
        if (!ftx_decode_candidate(&monitor.wf, candidates + i, 50, &message, &status)) continue;
        bool duplicate = false;
        for (int j = 0; j < result_count; ++j) if (memcmp(results[j].payload, message.payload, 10) == 0) { duplicate = true; break; }
        if (duplicate) continue;
        rd_result_t* result = results + result_count;
        ftx_message_offsets_t offsets;
        if (ftx_message_decode(&message, &hash_interface, result->text, &offsets) != FTX_MESSAGE_RC_OK) continue;
        result->frequency = (monitor.min_bin + candidates[i].freq_offset + (float)candidates[i].freq_sub / monitor.wf.freq_osr) / monitor.symbol_period;
        result->time = (candidates[i].time_offset + (float)candidates[i].time_sub / monitor.wf.time_osr) * monitor.symbol_period;
        result->score = candidates[i].score;
        memcpy(result->payload, message.payload, 10); ++result_count;
    }
    monitor_free(&monitor); return result_count;
}
const char* rd_result_text(int index) { return index >= 0 && index < result_count ? results[index].text : ""; }
float rd_result_frequency(int index) { return index >= 0 && index < result_count ? results[index].frequency : 0; }
float rd_result_time(int index) { return index >= 0 && index < result_count ? results[index].time : 0; }
int rd_result_score(int index) { return index >= 0 && index < result_count ? results[index].score : 0; }
