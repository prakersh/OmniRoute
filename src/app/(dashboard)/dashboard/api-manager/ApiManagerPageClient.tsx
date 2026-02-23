"use client";

import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { Card, Button, Input, Modal, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Constants for validation
const MAX_KEY_NAME_LENGTH = 100;
const MAX_SELECTED_MODELS = 500;

// Debounce hook for search optimization
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Sanitize user input to prevent XSS
function sanitizeInput(input: string): string {
  return input
    .replace(/[<>]/g, "")
    .replace(/"/g, "")
    .replace(/'/g, "")
    .trim()
    .slice(0, MAX_KEY_NAME_LENGTH);
}

// Validate key name
function validateKeyName(name: string): { valid: boolean; error?: string } {
  if (!name || !name.trim()) {
    return { valid: false, error: "Key name is required" };
  }
  if (name.length > MAX_KEY_NAME_LENGTH) {
    return { valid: false, error: `Key name must be ${MAX_KEY_NAME_LENGTH} characters or less` };
  }
  // Only allow alphanumeric, spaces, hyphens, underscores
  if (!/^[a-zA-Z0-9_\-\s]+$/.test(name)) {
    return {
      valid: false,
      error: "Key name can only contain letters, numbers, spaces, hyphens, and underscores",
    };
  }
  return { valid: true };
}

interface ApiKey {
  id: string;
  name: string;
  key: string;
  allowedModels: string[] | null;
  createdAt: string;
}

interface Model {
  id: string;
  owned_by: string;
}

/** Tuple type for models grouped by provider: [providerName, models[]] */
type ProviderGroup = [provider: string, models: Model[]];

export default function ApiManagerPageClient() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [searchModel, setSearchModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();
    fetchModels();
  }, []);

  const fetchModels = async () => {
    try {
      const res = await fetch("/v1/models");
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.data || []);
      }
    } catch (error) {
      console.log("Error fetching models:", error);
    }
  };

  const fetchData = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch (error) {
      console.log("Error fetching keys:", error);
    } finally {
      setLoading(false);
    }
  };

  const clearError = useCallback(() => setError(null), []);

  const handleCreateKey = async () => {
    // Validate and sanitize input
    const sanitizedName = sanitizeInput(newKeyName);
    const validation = validateKeyName(sanitizedName);

    if (!validation.valid) {
      setError(validation.error || "Invalid key name");
      return;
    }

    setIsSubmitting(true);
    clearError();

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sanitizedName }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setShowAddModal(false);
      } else {
        setError(data.error || "Failed to create key");
      }
    } catch (error) {
      console.error("Error creating key:", error);
      setError("Failed to create key. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    // Validate ID format to prevent injection
    if (!id || typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      setError("Invalid key ID");
      return;
    }

    if (!confirm("Delete this API key?")) return;

    setIsSubmitting(true);
    clearError();

    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        setKeys((prev) => prev.filter((k) => k.id !== id));
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete key");
      }
    } catch (error) {
      console.error("Error deleting key:", error);
      setError("Failed to delete key. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenPermissions = (key: ApiKey) => {
    if (!key || !key.id) return;
    setEditingKey(key);
    setShowPermissionsModal(true);
  };

  const handleUpdatePermissions = async (allowedModels: string[]) => {
    if (!editingKey || !editingKey.id) return;

    // Validate models array
    if (!Array.isArray(allowedModels)) {
      setError("Invalid models selection");
      return;
    }

    // Limit number of selected models to prevent abuse
    if (allowedModels.length > MAX_SELECTED_MODELS) {
      setError(`Cannot select more than ${MAX_SELECTED_MODELS} models`);
      return;
    }

    // Validate each model ID
    const validModels = allowedModels.filter(
      (id) => typeof id === "string" && id.length > 0 && id.length < 200
    );

    setIsSubmitting(true);
    clearError();

    try {
      const res = await fetch(`/api/keys/${encodeURIComponent(editingKey.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedModels: validModels }),
      });

      if (res.ok) {
        await fetchData();
        setShowPermissionsModal(false);
        setEditingKey(null);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update permissions");
      }
    } catch (error) {
      console.error("Error updating permissions:", error);
      setError("Failed to update permissions. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Debounced search for performance
  const debouncedSearchModel = useDebouncedValue(searchModel, 150);

  // Group models by provider
  const modelsByProvider = useMemo((): ProviderGroup[] => {
    const grouped: Record<string, Model[]> = {};
    for (const model of allModels) {
      const provider = model.owned_by || "unknown";
      if (!grouped[provider]) grouped[provider] = [];
      grouped[provider].push(model);
    }
    return Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
  }, [allModels]);

  // Filter models based on debounced search
  const filteredModelsByProvider = useMemo((): ProviderGroup[] => {
    if (!debouncedSearchModel.trim()) return modelsByProvider;

    const search = debouncedSearchModel.toLowerCase();
    return modelsByProvider
      .map(
        ([provider, models]): ProviderGroup => [
          provider,
          models.filter(
            (m) => m.id.toLowerCase().includes(search) || provider.toLowerCase().includes(search)
          ),
        ]
      )
      .filter(([, models]) => models.length > 0);
  }, [modelsByProvider, debouncedSearchModel]);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Error Banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <span className="material-symbols-outlined text-red-500">error</span>
          <p className="text-sm text-red-700 dark:text-red-300 flex-1">{error}</p>
          <button
            onClick={clearError}
            className="text-red-500 hover:text-red-700 transition-colors"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {/* Header Card */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">API Key Management</h2>
            <p className="text-sm text-text-muted">
              Create and manage API keys for authenticating requests to your endpoint
            </p>
          </div>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>
      </Card>

      {/* Keys List Card */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center size-10 rounded-lg bg-amber-500/10 shrink-0">
              <span className="material-symbols-outlined text-xl text-amber-500">vpn_key</span>
            </div>
            <div>
              <h3 className="font-semibold">Registered Keys</h3>
              <p className="text-xs text-text-muted">
                {keys.length} {keys.length === 1 ? "key" : "keys"} registered
              </p>
            </div>
          </div>
        </div>

        <p className="text-sm text-text-muted mb-4">
          Each key isolates usage tracking and can be revoked independently. Keys are masked after
          creation for security.
        </p>

        {keys.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border rounded-lg">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-2">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">
              Create your first API key to authenticate requests to your endpoint
            </p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Your First Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col border border-border rounded-lg overflow-hidden">
            {/* Table Header */}
            <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-surface/50 border-b border-border text-xs font-semibold text-text-muted uppercase tracking-wider">
              <div className="col-span-3">Name</div>
              <div className="col-span-4">Key</div>
              <div className="col-span-2">Permissions</div>
              <div className="col-span-1">Created</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>

            {/* Table Rows */}
            {keys.map((key) => (
              <div
                key={key.id}
                className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 hover:bg-surface/30 transition-colors group"
              >
                <div className="col-span-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-text-muted text-sm">label</span>
                  <span className="text-sm font-medium truncate">{key.name}</span>
                </div>
                <div className="col-span-4 flex items-center">
                  <code className="text-sm text-text-muted font-mono truncate">{key.key}</code>
                </div>
                <div className="col-span-2 flex items-center">
                  {Array.isArray(key.allowedModels) && key.allowedModels.length > 0 ? (
                    <button
                      onClick={() => handleOpenPermissions(key)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">lock</span>
                      {key.allowedModels.length}{" "}
                      {key.allowedModels.length === 1 ? "model" : "models"}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleOpenPermissions(key)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-500/20 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">lock_open</span>
                      All models
                    </button>
                  )}
                </div>
                <div className="col-span-1 flex items-center text-sm text-text-muted">
                  {new Date(key.createdAt).toLocaleDateString()}
                </div>
                <div className="col-span-2 flex items-center justify-end gap-1">
                  <button
                    onClick={() => handleOpenPermissions(key)}
                    className="p-2 hover:bg-primary/10 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-all"
                    title="Edit permissions"
                  >
                    <span className="material-symbols-outlined text-[18px]">tune</span>
                  </button>
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete key"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Usage Tips Card */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-blue-500/10 shrink-0">
            <span className="material-symbols-outlined text-xl text-blue-500">lightbulb</span>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Usage Tips</h3>
            <ul className="text-sm text-text-muted space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined text-xs text-primary mt-1">check</span>
                <span>
                  Use API keys in the{" "}
                  <code className="text-xs bg-surface px-1.5 py-0.5 rounded">Authorization</code>{" "}
                  header as{" "}
                  <code className="text-xs bg-surface px-1.5 py-0.5 rounded">Bearer YOUR_KEY</code>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined text-xs text-primary mt-1">check</span>
                <span>Keys are only shown once during creation — store them securely</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined text-xs text-primary mt-1">check</span>
                <span>Create separate keys for different clients or environments</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined text-xs text-primary mt-1">check</span>
                <span>Restrict keys to specific models for better security and cost control</span>
              </li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1.5 block">Key Name</label>
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="e.g., Production Key, Development Key"
              autoFocus
            />
            <p className="text-xs text-text-muted mt-1.5">
              Choose a descriptive name to identify this key&apos;s purpose
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create Key
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal isOpen={!!createdKey} title="API Key Created" onClose={() => setCreatedKey(null)}>
        <div className="flex flex-col gap-4">
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-green-600 dark:text-green-400">
                check_circle
              </span>
              <div>
                <p className="text-sm text-green-800 dark:text-green-200 font-medium mb-1">
                  Key created successfully!
                </p>
                <p className="text-sm text-green-700 dark:text-green-300">
                  Copy and store this key now — it won&apos;t be shown again.
                </p>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Input value={createdKey || ""} readOnly className="flex-1 font-mono text-sm" />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Permissions Modal */}
      {editingKey && (
        <PermissionsModal
          key={editingKey.id}
          isOpen={showPermissionsModal}
          onClose={() => {
            setShowPermissionsModal(false);
            setEditingKey(null);
          }}
          apiKey={editingKey}
          modelsByProvider={filteredModelsByProvider}
          allModels={allModels}
          searchModel={searchModel}
          onSearchChange={setSearchModel}
          onSave={handleUpdatePermissions}
        />
      )}
    </div>
  );
}

// -- Permissions Modal Component (Memoized for Performance) ------------------------------------------

const PermissionsModal = memo(function PermissionsModal({
  isOpen,
  onClose,
  apiKey,
  modelsByProvider,
  allModels,
  searchModel,
  onSearchChange,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  apiKey: ApiKey;
  modelsByProvider: ProviderGroup[];
  allModels: Model[];
  searchModel: string;
  onSearchChange: (v: string) => void;
  onSave: (models: string[]) => void;
}) {
  // Initialize state from props - component remounts when key prop changes
  const initialModels = Array.isArray(apiKey?.allowedModels) ? apiKey.allowedModels : [];
  const [selectedModels, setSelectedModels] = useState<string[]>(initialModels);
  const [allowAll, setAllowAll] = useState(initialModels.length === 0);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(() => {
    // Expand all providers by default when in restrict mode with existing selections
    if (initialModels.length > 0) {
      return new Set(modelsByProvider.map(([p]) => p));
    }
    return new Set();
  });

  // Memoize callbacks to prevent child re-renders
  const handleToggleModel = useCallback(
    (modelId: string) => {
      if (allowAll) return;

      setSelectedModels((prev) => {
        if (prev.includes(modelId)) {
          return prev.filter((m) => m !== modelId);
        }
        return [...prev, modelId];
      });
    },
    [allowAll]
  );

  const handleToggleProvider = useCallback(
    (provider: string, models: Model[]) => {
      if (allowAll) return;

      const modelIds = models.map((m) => m.id);
      setSelectedModels((prev) => {
        const allSelected = modelIds.every((id) => prev.includes(id));
        if (allSelected) {
          return prev.filter((m) => !modelIds.includes(m));
        }
        return [...new Set([...prev, ...modelIds])];
      });
    },
    [allowAll]
  );

  const handleSelectAll = useCallback(() => {
    setAllowAll(true);
    setSelectedModels([]);
  }, []);

  const handleRestrictMode = useCallback(() => {
    setAllowAll(false);
    // Expand all providers when entering restrict mode
    const allProviders = new Set(modelsByProvider.map(([p]) => p));
    setExpandedProviders(allProviders);
  }, [modelsByProvider]);

  const handleToggleExpand = useCallback((provider: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);

  const handleSelectAllModels = useCallback(() => {
    const allModelIds = allModels.map((m) => m.id);
    setSelectedModels(allModelIds);
  }, [allModels]);

  const handleDeselectAllModels = useCallback(() => {
    setSelectedModels([]);
  }, []);

  const handleSave = useCallback(() => {
    onSave(allowAll ? [] : selectedModels);
  }, [onSave, allowAll, selectedModels]);

  const handleClearSearch = useCallback(() => {
    onSearchChange("");
  }, [onSearchChange]);

  const selectedCount = selectedModels.length;
  const totalModels = allModels.length;

  return (
    <Modal
      isOpen={onClose ? isOpen : false}
      title={`Permissions: ${apiKey?.name || ""}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {/* Access Mode Toggle */}
        <div className="flex gap-2 p-1 bg-surface rounded-lg">
          <button
            onClick={handleSelectAll}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              allowAll
                ? "bg-primary text-white"
                : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">lock_open</span>
            Allow All
          </button>
          <button
            onClick={handleRestrictMode}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              !allowAll
                ? "bg-primary text-white"
                : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">lock</span>
            Restrict
          </button>
        </div>

        {/* Info Banner */}
        <div
          className={`flex items-start gap-2 p-3 rounded-lg ${
            allowAll
              ? "bg-green-500/10 border border-green-500/30"
              : "bg-amber-500/10 border border-amber-500/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[18px] ${
              allowAll ? "text-green-500" : "text-amber-500"
            }`}
          >
            {allowAll ? "info" : "warning"}
          </span>
          <p
            className={`text-xs ${
              allowAll ? "text-green-700 dark:text-green-300" : "text-amber-700 dark:text-amber-300"
            }`}
          >
            {allowAll
              ? "This key can access all available models."
              : `This key can access ${selectedCount} of ${totalModels} models.`}
          </p>
        </div>

        {/* Selected Models Summary (only in restrict mode) */}
        {!allowAll && selectedCount > 0 && (
          <div className="flex flex-col gap-1.5 p-2 bg-primary/5 rounded-lg border border-primary/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-primary">{selectedCount} selected</span>
              <div className="flex gap-1">
                <button
                  onClick={handleSelectAllModels}
                  className="text-[10px] text-primary hover:bg-primary/10 px-1.5 py-0.5 rounded transition-colors"
                >
                  All
                </button>
                <button
                  onClick={handleDeselectAllModels}
                  className="text-[10px] text-red-500 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto content-start">
              {selectedModels.map((modelId) => (
                <span
                  key={modelId}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-white dark:bg-surface text-text-main text-[10px] rounded border border-border"
                >
                  <span className="font-mono truncate max-w-[120px]" title={modelId}>
                    {modelId}
                  </span>
                  <button
                    onClick={() => handleToggleModel(modelId)}
                    className="text-text-muted hover:text-red-500 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Search and Model Selection (only in restrict mode) */}
        {!allowAll && (
          <>
            <div className="relative">
              <Input
                value={searchModel}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search models by name or provider..."
                icon="search"
              />
              {searchModel && (
                <button
                  onClick={() => onSearchChange("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              )}
            </div>

            <div className="max-h-[280px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
              {modelsByProvider.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-text-muted">
                  <span className="material-symbols-outlined text-2xl mb-1">search_off</span>
                  <p className="text-xs">No models found</p>
                </div>
              ) : (
                modelsByProvider.map(([provider, models]) => {
                  const selectedInProvider = selectedModels.filter((m) =>
                    models.some((model) => model.id === m)
                  ).length;
                  const allSelected = models.every((m) => selectedModels.includes(m.id));
                  const someSelected = selectedInProvider > 0 && !allSelected;

                  return (
                    <div key={provider} className="group">
                      <button
                        onClick={() => handleToggleExpand(provider)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface/50 transition-colors text-left"
                      >
                        <span
                          className={`material-symbols-outlined text-base transition-transform duration-200 ${
                            expandedProviders.has(provider) ? "rotate-90" : ""
                          }`}
                        >
                          chevron_right
                        </span>
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div
                            className="relative flex items-center cursor-pointer shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleProvider(provider, models);
                            }}
                          >
                            <div
                              className={`w-4 h-4 rounded border-2 transition-colors flex items-center justify-center ${
                                allSelected
                                  ? "bg-primary border-primary"
                                  : someSelected
                                    ? "bg-primary/20 border-primary"
                                    : "border-border hover:border-primary/50"
                              }`}
                            >
                              {allSelected && (
                                <span className="material-symbols-outlined text-white text-[12px]">
                                  check
                                </span>
                              )}
                              {someSelected && !allSelected && (
                                <span className="material-symbols-outlined text-primary text-[12px]">
                                  remove
                                </span>
                              )}
                            </div>
                          </div>
                          <span className="text-xs font-semibold text-text-main truncate">
                            {provider}
                          </span>
                          <span className="text-[10px] text-text-muted bg-surface px-1 py-0.5 rounded shrink-0">
                            {models.length}
                          </span>
                        </div>
                        {selectedInProvider > 0 && (
                          <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full shrink-0">
                            {selectedInProvider}
                          </span>
                        )}
                      </button>

                      {/* Expandable model list */}
                      {expandedProviders.has(provider) && (
                        <div className="px-3 pb-2 pl-9">
                          <div className="flex flex-wrap gap-1">
                            {models.map((model) => {
                              const isSelected = selectedModels.includes(model.id);
                              return (
                                <button
                                  key={model.id}
                                  onClick={() => handleToggleModel(model.id)}
                                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono transition-all ${
                                    isSelected
                                      ? "bg-primary text-white"
                                      : "bg-surface border border-border text-text-muted hover:border-primary/50 hover:text-text-main"
                                  }`}
                                  title={model.id}
                                >
                                  {model.id}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth>
            Save Permissions
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
});
