"""Joint text-image embedding models behind one interface.

Each adapter exposes ``encode_images(list[PIL]) -> np.ndarray`` and
``encode_texts(list[str]) -> np.ndarray``, both L2-normalized float32, so search is a
plain dot product — the same shape the main app would use (BLOB column + numpy matmul).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class EmbedSpec:
    key: str            # short id used in results/report
    family: str         # "open_clip" | "jina" | "nomic"
    model: str
    pretrained: str = ""
    note: str = ""


SPECS: list[EmbedSpec] = [
    EmbedSpec("clip-b32-openai", "open_clip", "ViT-B-32-quickgelu", "openai", "Original 2021 CLIP baseline"),
    EmbedSpec("mobileclip2-s2", "open_clip", "MobileCLIP2-S2", "dfndr2b", "Apple, mobile-sized"),
    EmbedSpec("mobileclip2-b", "open_clip", "MobileCLIP2-B", "dfndr2b", "Apple, ViT-B"),
    EmbedSpec("siglip2-b16-256", "open_clip", "ViT-B-16-SigLIP2-256", "webli", "Google SigLIP 2, base"),
    EmbedSpec("siglip2-so400m-384", "open_clip", "ViT-SO400M-16-SigLIP2-384", "webli", "Google SigLIP 2, large"),
    EmbedSpec("pe-core-b16", "open_clip", "PE-Core-B-16", "meta", "Meta Perception Encoder, base"),
    EmbedSpec("pe-core-l14-336", "open_clip", "PE-Core-L-14-336", "meta", "Meta Perception Encoder, large"),
    EmbedSpec("dfn-l14", "open_clip", "ViT-L-14-quickgelu", "dfn2b", "Apple DFN-trained OpenCLIP L/14"),
    EmbedSpec("jina-clip-v2", "jina", "jinaai/jina-clip-v2", note="Multilingual, strong text side"),
    EmbedSpec("nomic-v1.5", "nomic", "nomic-ai/nomic-embed-vision-v1.5", note="Shares space with nomic-embed-text"),
]


def _norm(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x / np.linalg.norm(x, axis=-1, keepdims=True).clip(1e-12)


class Embedder:
    def __init__(self, spec: EmbedSpec, device: str):
        import torch
        self.spec, self.device = spec, device
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        getattr(self, f"_load_{spec.family}")()

    # ── open_clip ──
    def _load_open_clip(self):
        import open_clip
        m, _, pre = open_clip.create_model_and_transforms(self.spec.model, pretrained=self.spec.pretrained)
        self.model = m.to(self.device, self.dtype).eval()
        self.pre = pre
        self.tok = open_clip.get_tokenizer(self.spec.model)

    def _img_open_clip(self, imgs):
        import torch
        x = torch.stack([self.pre(i) for i in imgs]).to(self.device, self.dtype)
        return self.model.encode_image(x)

    def _txt_open_clip(self, texts):
        return self.model.encode_text(self.tok(texts).to(self.device))

    # ── jina-clip-v2 ──
    def _load_jina(self):
        from transformers import AutoModel
        self.model = AutoModel.from_pretrained(self.spec.model, trust_remote_code=True,
                                               torch_dtype=self.dtype).to(self.device).eval()

    def _img_jina(self, imgs):
        return self.model.encode_image(imgs, convert_to_numpy=True)

    def _txt_jina(self, texts):
        return self.model.encode_text(texts, task="retrieval.query", convert_to_numpy=True)

    # ── nomic v1.5 (separate vision + text towers in one space) ──
    def _load_nomic(self):
        from sentence_transformers import SentenceTransformer
        from transformers import AutoImageProcessor, AutoModel
        self.proc = AutoImageProcessor.from_pretrained(self.spec.model)
        self.model = AutoModel.from_pretrained(self.spec.model, trust_remote_code=True,
                                               torch_dtype=self.dtype).to(self.device).eval()
        self.text = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5", trust_remote_code=True,
                                        device=self.device)
        if self.device == "cuda":
            self.text.half()

    def _img_nomic(self, imgs):
        x = self.proc(imgs, return_tensors="pt")["pixel_values"].to(self.device, self.dtype)
        return self.model(pixel_values=x).last_hidden_state[:, 0]

    def _txt_nomic(self, texts):
        import torch.nn.functional as F
        e = self.text.encode([f"search_query: {t}" for t in texts], convert_to_tensor=True)
        e = F.layer_norm(e.float(), normalized_shape=(e.shape[1],))[:, :768]
        return e

    # ── public ──
    def encode_images(self, imgs) -> np.ndarray:
        import torch
        with torch.inference_mode():
            out = getattr(self, f"_img_{self.spec.family}")(imgs)
        return _norm(out.float().cpu().numpy() if hasattr(out, "cpu") else out)

    def encode_texts(self, texts) -> np.ndarray:
        import torch
        with torch.inference_mode():
            out = getattr(self, f"_txt_{self.spec.family}")(texts)
        return _norm(out.float().cpu().numpy() if hasattr(out, "cpu") else out)

    def n_params(self) -> int:
        n = sum(p.numel() for p in self.model.parameters())
        if self.spec.family == "nomic":
            n += sum(p.numel() for p in self.text.parameters())
        return n
