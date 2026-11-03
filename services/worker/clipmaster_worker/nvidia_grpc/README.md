# Interfaces gRPC de NVIDIA Maxine (Eye Contact y Relighting)

- `protos/` son las definiciones oficiales de [NVIDIA-Maxine/nim-clients](https://github.com/NVIDIA-Maxine/nim-clients) (licencia MIT, cabecera en cada `.proto`).
- Los `*_pb2.py` / `*_pb2_grpc.py` se generan con `grpcio-tools` (misma versión que `grpcio` en `requirements.txt`). Los imports `nvidia.*` se reescriben a `clipmaster_worker.nvidia_grpc.nvidia.*` para no chocar con los paquetes `nvidia-*` de CUDA.

Regenerar:

```bash
cd services/worker/clipmaster_worker/nvidia_grpc/protos
python -m grpc_tools.protoc -I. --python_out=.. --grpc_python_out=.. $(find . -name '*.proto')
cd .. && find nvidia -name '*.py' -exec sed -i -E 's/^from nvidia\./from clipmaster_worker.nvidia_grpc.nvidia./' {} +
```
