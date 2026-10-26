CLANG ?= clang
all: ../soundproof.wasm
../soundproof.wasm: soundproof.c
	$(CLANG) --target=wasm32 -O3 -ffp-contract=off -fno-builtin -nostdlib -Wl,--no-entry -Wl,--export-memory -Wl,--export=allocate -Wl,--export=reset_alloc -Wl,--export=repair_pcm -Wl,--export=analyze -Wl,--export=metric -Wl,--export=event_count -Wl,--export=event_start -Wl,--export=event_end -Wl,--export=waveform_min -Wl,--export=waveform_max -Wl,--export=band_value -Wl,--export=wasm_version -Wl,-z,stack-size=1048576 -o ../soundproof.wasm soundproof.c
