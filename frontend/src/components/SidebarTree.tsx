import React from 'react';
import { FileTextOutlined, FolderOutlined, RightOutlined, DownOutlined } from '@ant-design/icons';
import { TreeNode } from '../api';

interface SidebarTreeProps {
  nodes: TreeNode[];
  expandedKeys: Set<string>;
  selectedKey: string | null;
  onToggleExpand: (key: string) => void;
  onSelect: (node: TreeNode) => void;
}

export const SidebarTree: React.FC<SidebarTreeProps> = ({
  nodes,
  expandedKeys,
  selectedKey,
  onToggleExpand,
  onSelect,
}) => {
  const renderNodes = (list: TreeNode[], depth: number) =>
    list.map((node) => {
      const isExpanded = expandedKeys.has(node.key);
      const isSelected = selectedKey === node.key;
      const isSource = node.key.startsWith('source::');

      return (
        <React.Fragment key={node.key}>
          <div
            className={`mac-tree-row${isSource ? ' is-source' : ''}${isSelected ? ' is-selected' : ''}`}
            style={{ paddingLeft: depth * 14 + 8 }}
            title={node.rel_path || node.title}
            onClick={() => {
              if (!node.isLeaf && isSource) {
                onToggleExpand(node.key);
              }
              onSelect(node);
            }}
          >
            {!node.isLeaf ? (
              <span
                className="mac-tree-chevron"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(node.key);
                }}
              >
                {isExpanded ? <DownOutlined /> : <RightOutlined />}
              </span>
            ) : (
              <span className="mac-tree-chevron" />
            )}

            <span className="mac-tree-icon">
              {node.isLeaf ? <FileTextOutlined /> : <FolderOutlined />}
            </span>

            <span className="mac-tree-label">{node.title}</span>

            {!node.isLeaf && typeof node.count === 'number' && (
              <span className="mac-tree-count">{node.count}</span>
            )}
          </div>
          {!node.isLeaf && isExpanded && node.children && node.children.length > 0 && (
            <div className="mac-tree-children">{renderNodes(node.children, depth + 1)}</div>
          )}
        </React.Fragment>
      );
    });

  return <div className="mac-tree">{renderNodes(nodes, 0)}</div>;
};
