"""Captioning / VLM models behind one interface: ``caption(PIL) -> (text, n_new_tokens)``.

All VLMs get the same prompt and the same 768px-long-side input so speed and output
are comparable. Gemma 3 is omitted: it's a gated HF repo and needs a login token.
"""
from __future__ import annotations

from dataclasses import dataclass

PROMPT = ("Describe this photo in 2-3 sentences for a photo search index. Mention the main "
          "subject, setting, notable objects, colors, time of day, and any readable text or "
          "recognizable landmarks.")
MAX_SIDE = 768
MAX_NEW = 120


@dataclass
class CapSpec:
    key: str
    family: str          # "florence" | "moondream" | "chat"
    model: str
    note: str = ""
    cpu: bool = False    # also time on CPU (only practical for small models)
    quant4: bool = False
    revision: str | None = None


SPECS: list[CapSpec] = [
    CapSpec("florence2-base", "florence", "florence-community/Florence-2-base",
            "0.23B, MIT; task <MORE_DETAILED_CAPTION>", cpu=True),
    CapSpec("florence2-large", "florence", "florence-community/Florence-2-large",
            "0.77B, MIT; task <MORE_DETAILED_CAPTION>", cpu=True),
    CapSpec("moondream2", "moondream", "vikhyatk/moondream2", "1.9B tiny VLM, Apache-2.0",
            cpu=True, revision="2025-06-21"),
    CapSpec("smolvlm2-2.2b", "chat", "HuggingFaceTB/SmolVLM2-2.2B-Instruct", "HF tiny VLM, Apache-2.0", cpu=True),
    CapSpec("qwen2.5-vl-3b", "chat", "Qwen/Qwen2.5-VL-3B-Instruct", "Qwen 2.5 VL 3B"),
    CapSpec("qwen3-vl-4b", "chat", "Qwen/Qwen3-VL-4B-Instruct", "Qwen 3 VL 4B, Apache-2.0"),
    CapSpec("qwen3-vl-8b-nf4", "chat", "Qwen/Qwen3-VL-8B-Instruct", "Qwen 3 VL 8B, 4-bit NF4 to fit 12GB",
            quant4=True),
]


def _fit(img):
    img = img.copy()
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return img


class Captioner:
    def __init__(self, spec: CapSpec, device: str):
        import torch
        self.spec, self.device = spec, device
        self.dtype = (torch.bfloat16 if device == "cuda" else torch.float32)
        getattr(self, f"_load_{spec.family}")()

    # ── Florence-2 (native transformers port) ──
    def _load_florence(self):
        from transformers import AutoProcessor, Florence2ForConditionalGeneration
        self.proc = AutoProcessor.from_pretrained(self.spec.model)
        self.model = Florence2ForConditionalGeneration.from_pretrained(
            self.spec.model, torch_dtype=self.dtype).to(self.device).eval()

    def _cap_florence(self, img):
        task = "<MORE_DETAILED_CAPTION>"
        inp = self.proc(text=task, images=img, return_tensors="pt").to(self.device, self.dtype)
        ids = self.model.generate(**inp, max_new_tokens=MAX_NEW, num_beams=3, do_sample=False)
        # Encoder-decoder: generate() returns decoder tokens only, no prompt prefix.
        text = self.proc.batch_decode(ids, skip_special_tokens=True)[0]
        return text.strip(), int(ids.shape[1])

    # ── Moondream 2 (remote code, its own .caption API) ──
    def _load_moondream(self):
        from transformers import AutoModelForCausalLM
        self.model = AutoModelForCausalLM.from_pretrained(
            self.spec.model, revision=self.spec.revision, trust_remote_code=True,
            torch_dtype=self.dtype, device_map={"": self.device}).eval()

    def _cap_moondream(self, img):
        text = self.model.caption(img, length="normal")["caption"]
        return text.strip(), None

    # ── Generic chat-template VLMs (Qwen-VL, SmolVLM) ──
    def _load_chat(self):
        from transformers import AutoModelForImageTextToText, AutoProcessor
        kw = {"torch_dtype": self.dtype}
        if self.spec.quant4:
            import torch
            from transformers import BitsAndBytesConfig
            kw["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
            kw["device_map"] = {"": 0}
        self.proc = AutoProcessor.from_pretrained(self.spec.model)
        self.model = AutoModelForImageTextToText.from_pretrained(self.spec.model, **kw)
        if not self.spec.quant4:
            self.model = self.model.to(self.device)
        self.model.eval()

    def _cap_chat(self, img):
        msgs = [{"role": "user", "content": [{"type": "image", "image": img},
                                             {"type": "text", "text": PROMPT}]}]
        inp = self.proc.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True,
                                            return_dict=True, return_tensors="pt").to(self.device)
        if "pixel_values" in inp:
            inp["pixel_values"] = inp["pixel_values"].to(self.dtype)
        ids = self.model.generate(**inp, max_new_tokens=MAX_NEW, do_sample=False)
        new = ids[0, inp["input_ids"].shape[1]:]
        return self.proc.decode(new, skip_special_tokens=True).strip(), int(new.shape[0])

    # ── public ──
    def caption(self, img) -> tuple[str, int | None]:
        import torch
        with torch.inference_mode():
            return getattr(self, f"_cap_{self.spec.family}")(_fit(img))

    def n_params(self) -> int:
        return sum(p.numel() for p in self.model.parameters())
