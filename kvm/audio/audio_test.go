package audio

import "testing"

func TestDownsampleKeepsWholeFrames(t *testing.T) {
	buf := make([]byte, chunkBytes)
	for i := range buf {
		buf[i] = byte(i / frameBytes) // every byte of frame n is n
	}
	for quality, step := range map[string]int{"high": 1, "standard": 2, "low": 3} {
		out := Downsample(buf, quality)
		if len(out) != chunkBytes/step {
			t.Fatalf("%s: got %d bytes, want %d", quality, len(out), chunkBytes/step)
		}
		for i := 0; i < len(out); i += frameBytes {
			frame := out[i : i+frameBytes]
			want := byte((i / frameBytes) * step)
			for _, b := range frame {
				if b != want {
					t.Fatalf("%s: frame %d mixes samples of different frames: %v", quality, i/frameBytes, frame)
				}
			}
		}
	}
}

func TestPCMToHW(t *testing.T) {
	hw, err := PCMToHW("/dev/snd/pcmC3D0c")
	if err != nil || hw != "hw:3,0" {
		t.Fatalf("got %q, %v", hw, err)
	}
	if _, err := PCMToHW("/dev/video0"); err == nil {
		t.Fatal("invalid node accepted")
	}
}
