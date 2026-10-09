package demo

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"sync"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"

	"kvmconsole/kvm/capture"
)

// Source renders the demo desktop as an MJPEG stream.
type Source struct {
	st *State

	mu   sync.Mutex
	stop chan struct{}
	done chan struct{}
	bg   *image.RGBA // cached background for the current size
}

// NewSource returns a capture.Source rendering st.
func NewSource(st *State) *Source { return &Source{st: st} }

var _ capture.Source = (*Source)(nil)

// Modes implements capture.Source.
func (s *Source) Modes() ([]capture.SizeInfo, error) {
	return append([]capture.SizeInfo(nil), Modes...), nil
}

// Open implements capture.Source.
func (s *Source) Open(res capture.Resolution) (<-chan []byte, capture.StreamInfo, error) {
	if !capture.SupportsResolution(Modes, res) {
		return nil, capture.StreamInfo{}, fmt.Errorf("demo source does not support %dx%d @ %d fps", res.Width, res.Height, res.FPS)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stop != nil {
		return nil, capture.StreamInfo{}, errors.New("demo capture already started")
	}
	s.st.setSize(res.Width, res.Height)
	s.bg = renderBackground(res.Width, res.Height)
	s.stop = make(chan struct{})
	s.done = make(chan struct{})

	// JPEG encoding a full HD frame costs tens of milliseconds in pure Go,
	// so the demo renders at a reduced rate; the stream still behaves like
	// a real one for the browser.
	renderFPS := res.FPS
	if limit := 20; res.Width >= 1920 && renderFPS > 12 {
		renderFPS = 12
	} else if renderFPS > limit {
		renderFPS = limit
	}

	out := make(chan []byte, 2)
	go s.loop(out, res, renderFPS, s.bg, s.stop, s.done)

	info := capture.StreamInfo{
		Description: fmt.Sprintf("Demo capture - Motion-JPEG [%dx%d] %d fps", res.Width, res.Height, res.FPS),
		Width:       res.Width,
		Height:      res.Height,
		FPS:         res.FPS,
	}
	return out, info, nil
}

// Close implements capture.Source.
func (s *Source) Close() error {
	s.mu.Lock()
	stop, done := s.stop, s.done
	s.stop, s.done = nil, nil
	s.mu.Unlock()
	if stop == nil {
		return nil
	}
	close(stop)
	<-done
	return nil
}

func (s *Source) loop(out chan<- []byte, res capture.Resolution, fps int, bg *image.RGBA, stop, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(time.Second / time.Duration(fps))
	defer ticker.Stop()
	frame := image.NewRGBA(bg.Rect)
	var buf bytes.Buffer
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			copy(frame.Pix, bg.Pix)
			drawDesktop(frame, s.st.snapshot(), res)
			buf.Reset()
			if err := jpeg.Encode(&buf, frame, &jpeg.Options{Quality: 75}); err != nil {
				continue
			}
			select {
			case out <- append([]byte(nil), buf.Bytes()...):
			default: // the hub is behind; drop this frame like a real card would
			}
		}
	}
}

/* --- Rendering ---------------------------------------------------------- */

var (
	colWindow    = color.RGBA{0x1f, 0x24, 0x33, 0xff}
	colTitleBar  = color.RGBA{0x2b, 0x32, 0x45, 0xff}
	colText      = color.RGBA{0xe8, 0xec, 0xf4, 0xff}
	colMuted     = color.RGBA{0x9a, 0xa4, 0xb8, 0xff}
	colAccent    = color.RGBA{0x5b, 0x8c, 0xff, 0xff}
	colGood      = color.RGBA{0x3d, 0xd6, 0x8c, 0xff}
	colWarn      = color.RGBA{0xff, 0xb0, 0x3d, 0xff}
	colTaskbar   = color.RGBA{0x10, 0x13, 0x1c, 0xff}
	colInput     = color.RGBA{0x14, 0x18, 0x22, 0xff}
	colBlack     = color.RGBA{0, 0, 0, 0xff}
	colWhite     = color.RGBA{0xff, 0xff, 0xff, 0xff}
	colButtonOn  = color.RGBA{0x5b, 0x8c, 0xff, 0xff}
	colButtonOff = color.RGBA{0x3a, 0x42, 0x58, 0xff}
)

func renderBackground(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// Diagonal two-tone gradient
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			t := float64(x)/float64(w)*0.6 + float64(y)/float64(h)*0.4
			r := uint8(0x14 + t*(0x3a-0x14))
			g := uint8(0x1e + t*(0x2a-0x1e))
			b := uint8(0x3c + t*(0x6e-0x3c))
			i := img.PixOffset(x, y)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = r, g, b, 0xff
		}
	}
	// Taskbar
	fillRect(img, image.Rect(0, h-scaled(h, 40), w, h), colTaskbar)
	return img
}

// scaled turns a size designed for 720p into one for the current height.
func scaled(h, v int) int {
	out := v * h / 720
	if out < 1 {
		return 1
	}
	return out
}

func drawDesktop(img *image.RGBA, st snapshot, res capture.Resolution) {
	w, h := res.Width, res.Height
	textScale := 1
	if h >= 700 {
		textScale = 2
	}
	if h >= 1000 {
		textScale = 3
	}
	lineH := 15 * textScale

	// Taskbar clock and title
	now := time.Now()
	barTop := h - scaled(h, 40)
	drawText(img, scaled(h, 16), barTop+(scaled(h, 40)-13*textScale)/2, "KVM Console demo", colText, textScale)
	clock := now.Format("15:04:05")
	drawText(img, w-scaled(h, 16)-len(clock)*7*textScale, barTop+(scaled(h, 40)-13*textScale)/2, clock, colText, textScale)

	// Main window
	win := image.Rect(w/10, h/10, w*9/10, barTop-h/12)
	fillRect(img, win.Add(image.Pt(scaled(h, 6), scaled(h, 8))), color.RGBA{0, 0, 0, 0xff})
	fillRect(img, win, colWindow)
	title := image.Rect(win.Min.X, win.Min.Y, win.Max.X, win.Min.Y+lineH+scaled(h, 14))
	fillRect(img, title, colTitleBar)
	for i, c := range []color.RGBA{{0xff, 0x5f, 0x57, 0xff}, {0xfe, 0xbc, 0x2e, 0xff}, {0x28, 0xc8, 0x40, 0xff}} {
		r := scaled(h, 6)
		cx := title.Min.X + scaled(h, 16) + i*scaled(h, 20)
		fillCircle(img, cx, (title.Min.Y+title.Max.Y)/2, r, c)
	}
	drawText(img, title.Min.X+scaled(h, 84), title.Min.Y+(title.Dy()-13*textScale)/2, "Virtual remote machine", colText, textScale)

	x := win.Min.X + scaled(h, 24)
	y := title.Max.Y + scaled(h, 18)
	line := func(label, value string, col color.RGBA) {
		drawText(img, x, y, label, colMuted, textScale)
		drawText(img, x+16*7*textScale, y, value, col, textScale)
		y += lineH + scaled(h, 6)
	}
	line("Resolution", fmt.Sprintf("%d x %d @ %d fps", w, h, res.FPS), colText)
	line("Uptime", st.uptime.Truncate(time.Second).String(), colText)
	line("Pointer", fmt.Sprintf("%4.0f, %4.0f", st.x*float64(w), st.y*float64(h)), colText)
	line("Held keys", describeHeld(st.modifiers, st.keys), colWarn)
	line("Last event", st.lastEvent, colGood)
	line("HID events", fmt.Sprintf("%d  (resets: %d, wheel: %d)", st.events, st.resets, st.scroll), colText)

	// Mouse button indicators
	y += scaled(h, 4)
	drawText(img, x, y, "Buttons", colMuted, textScale)
	bx := x + 16*7*textScale
	for _, b := range []struct {
		bit  uint8
		name string
	}{{0x01, "L"}, {0x04, "M"}, {0x02, "R"}} {
		c := colButtonOff
		if st.buttons&b.bit != 0 {
			c = colButtonOn
		}
		box := image.Rect(bx, y-scaled(h, 2), bx+lineH+scaled(h, 8), y+lineH)
		fillRect(img, box, c)
		drawText(img, bx+(box.Dx()-7*textScale)/2, y, b.name, colWhite, textScale)
		bx += box.Dx() + scaled(h, 8)
	}
	y += lineH + scaled(h, 22)

	// Text input box showing what was typed
	drawText(img, x, y, "Type something - it appears here:", colMuted, textScale)
	y += lineH + scaled(h, 6)
	box := image.Rect(x, y, win.Max.X-scaled(h, 24), y+2*lineH+scaled(h, 20))
	fillRect(img, box, colInput)
	strokeRect(img, box, colAccent)
	if st.prevLine != "" {
		drawText(img, box.Min.X+scaled(h, 10), box.Min.Y+scaled(h, 6), tail(st.prevLine, 60), colMuted, textScale)
	}
	cursor := "_"
	if now.UnixMilli()/500%2 == 0 {
		cursor = " "
	}
	drawText(img, box.Min.X+scaled(h, 10), box.Min.Y+scaled(h, 10)+lineH, tail(st.line, 60)+cursor, colText, textScale)

	// Pointer last, so it sits on top of everything
	drawCursor(img, int(st.x*float64(w-1)), int(st.y*float64(h-1)), textScale)
}

func tail(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[len(r)-n:])
	}
	return s
}

func fillRect(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	draw.Draw(img, r.Intersect(img.Rect), &image.Uniform{c}, image.Point{}, draw.Src)
}

func strokeRect(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	fillRect(img, image.Rect(r.Min.X, r.Min.Y, r.Max.X, r.Min.Y+2), c)
	fillRect(img, image.Rect(r.Min.X, r.Max.Y-2, r.Max.X, r.Max.Y), c)
	fillRect(img, image.Rect(r.Min.X, r.Min.Y, r.Min.X+2, r.Max.Y), c)
	fillRect(img, image.Rect(r.Max.X-2, r.Min.Y, r.Max.X, r.Max.Y), c)
}

func fillCircle(img *image.RGBA, cx, cy, r int, c color.RGBA) {
	for y := -r; y <= r; y++ {
		for x := -r; x <= r; x++ {
			if x*x+y*y <= r*r && image.Pt(cx+x, cy+y).In(img.Rect) {
				img.SetRGBA(cx+x, cy+y, c)
			}
		}
	}
}

// drawCursor draws a classic arrow pointer with its tip at (x, y).
func drawCursor(img *image.RGBA, x, y, scale int) {
	size := 12 * scale
	for row := 0; row <= size+2; row++ {
		width := row*2/3 + 1
		for col := -1; col <= width; col++ {
			px, py := x+col, y+row
			if !image.Pt(px, py).In(img.Rect) {
				continue
			}
			if col == -1 || col == width || row == size+2 {
				img.SetRGBA(px, py, colBlack)
			} else if row <= size {
				img.SetRGBA(px, py, colWhite)
			}
		}
	}
}

// drawText renders ASCII text with the built-in 7x13 bitmap font, scaled up
// by an integer factor with nearest-neighbour sampling. (x, y) is the top
// left corner of the text.
func drawText(img *image.RGBA, x, y int, s string, c color.RGBA, scale int) {
	if s == "" {
		return
	}
	face := basicfont.Face7x13
	mask := image.NewAlpha(image.Rect(0, 0, len(s)*7, 13))
	d := font.Drawer{Dst: mask, Src: image.Opaque, Face: face, Dot: fixed.P(0, 10)}
	d.DrawString(s)
	for my := 0; my < 13; my++ {
		for mx := 0; mx < mask.Rect.Dx(); mx++ {
			if mask.AlphaAt(mx, my).A < 128 {
				continue
			}
			for py := y + my*scale; py < y+(my+1)*scale; py++ {
				for px := x + mx*scale; px < x+(mx+1)*scale; px++ {
					if image.Pt(px, py).In(img.Rect) {
						img.SetRGBA(px, py, c)
					}
				}
			}
		}
	}
}
