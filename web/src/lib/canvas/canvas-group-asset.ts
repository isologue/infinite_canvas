import { nanoid } from "nanoid";

import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, Position } from "@/types/canvas";

export type CanvasGroupAssetData = {
    group: CanvasNodeData;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type InstantiatedCanvasGroupAsset = {
    group: CanvasNodeData;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export function createCanvasGroupAssetData(group: CanvasNodeData, allNodes: CanvasNodeData[], allConnections: CanvasConnection[]): CanvasGroupAssetData | null {
    const nodeIds = new Set(allNodes.filter((node) => node.metadata?.groupId === group.id).map((node) => node.id));
    if (!nodeIds.size) return null;

    let changed = true;
    while (changed) {
        changed = false;
        allNodes.forEach((node) => {
            const parentId = node.metadata?.batchRootId;
            if (parentId && nodeIds.has(parentId) && !nodeIds.has(node.id)) {
                nodeIds.add(node.id);
                changed = true;
            }
        });
    }

    const nodes = allNodes.filter((node) => nodeIds.has(node.id));
    return {
        group: clone(group),
        nodes: nodes.map(clone),
        connections: allConnections.filter((connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId)).map(clone),
    };
}

export function instantiateCanvasGroupAsset(data: CanvasGroupAssetData, center: Position): InstantiatedCanvasGroupAsset | null {
    if (!data?.group || !Array.isArray(data.nodes) || !data.nodes.length) return null;

    const sourceNodes = [data.group, ...data.nodes];
    const idMap = new Map(sourceNodes.map((node) => [node.id, `${node.type}-${nanoid()}`]));
    const bounds = nodeBounds(sourceNodes);
    const offset = { x: center.x - (bounds.left + bounds.right) / 2, y: center.y - (bounds.top + bounds.bottom) / 2 };
    const remapNode = (node: CanvasNodeData): CanvasNodeData => ({
        ...clone(node),
        id: idMap.get(node.id) || `${node.type}-${nanoid()}`,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        metadata: remapMetadata(node.metadata, idMap),
    });

    const group = remapNode(data.group);
    const nodes = data.nodes.map(remapNode);
    const validNodeIds = new Set(data.nodes.map((node) => node.id));
    const connections = data.connections
        .filter((connection) => validNodeIds.has(connection.fromNodeId) && validNodeIds.has(connection.toNodeId))
        .map((connection) => ({ id: `connection-${nanoid()}`, fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)! }));

    return { group, nodes, connections };
}

export function getCanvasGroupAssetCover(data: CanvasGroupAssetData) {
    return data.nodes.find((node) => node.type === "image" && Boolean(node.metadata?.content))?.metadata?.content || "";
}

export function canvasGroupAssetSummary(data: CanvasGroupAssetData) {
    return `${data.nodes.length} 个节点 · ${data.connections.length} 条连线`;
}

function remapMetadata(metadata: CanvasNodeMetadata | undefined, idMap: Map<string, string>) {
    if (!metadata) return undefined;
    const next = remapNodeReferences(clone(metadata), idMap);
    if (next.groupId) {
        const groupId = idMap.get(next.groupId);
        if (groupId) next.groupId = groupId;
        else delete next.groupId;
    }
    if (next.batchRootId) {
        const batchRootId = idMap.get(next.batchRootId);
        if (batchRootId) next.batchRootId = batchRootId;
        else delete next.batchRootId;
    }
    if (next.batchChildIds) next.batchChildIds = next.batchChildIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
    if (next.primaryImageId) {
        const primaryImageId = idMap.get(next.primaryImageId);
        if (primaryImageId) next.primaryImageId = primaryImageId;
        else delete next.primaryImageId;
    }
    return next;
}

function remapNodeReferences<T>(value: T, idMap: Map<string, string>): T {
    if (typeof value === "string") return value.replace(/@\[node:([^\]]+)\]/g, (match, nodeId) => (idMap.has(nodeId) ? `@[node:${idMap.get(nodeId)}]` : match)) as T;
    if (Array.isArray(value)) return value.map((item) => remapNodeReferences(item, idMap)) as T;
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapNodeReferences(item, idMap)])) as T;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

