from pathlib import Path
import hashlib

try:
    import onnx
except ImportError as exc:
    raise SystemExit("Missing dependency: install it with python3 -m pip install onnx") from exc

MODEL_PATH = Path(__file__).parent / "models" / "face-detector" / "face_detection_yunet_2023mar.onnx"
EXPECTED_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

if not MODEL_PATH.is_file():
    raise SystemExit(f"Model not found: {MODEL_PATH}")

data = MODEL_PATH.read_bytes()
actual_sha256 = hashlib.sha256(data).hexdigest()
print(f"Model: {MODEL_PATH}")
print(f"Size: {len(data)} bytes")
print(f"SHA256: {actual_sha256}")

if actual_sha256 != EXPECTED_SHA256:
    raise SystemExit("SHA256 mismatch. Re-download the official YuNet model.")

model = onnx.load(str(MODEL_PATH))
print("Inputs:")
for tensor in model.graph.input:
    dims = []
    for dim in tensor.type.tensor_type.shape.dim:
        dims.append(dim.dim_value if dim.dim_value else dim.dim_param if dim.dim_param else "?")
    print(f"  {tensor.name}: {dims}")
print("Outputs:")
for tensor in model.graph.output:
    dims = []
    for dim in tensor.type.tensor_type.shape.dim:
        dims.append(dim.dim_value if dim.dim_value else dim.dim_param if dim.dim_param else "?")
    print(f"  {tensor.name}: {dims}")
print("YuNet model verification passed.")