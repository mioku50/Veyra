-- P8.6 -- an ERC-8004 identity is a registry and an agent id, not an address.
--
-- nova_agents already carried `arc_identity_address`, which encodes the wrong
-- model. In ERC-8004 an agent's identity is an ERC-721 token: the pair
-- (identity registry, agentId) names the agent, and the owning address is a
-- separate role that can change. The standard keeps a third thing apart again
-- -- an operational agentWallet -- which need not be the owner either.
--
-- Storing an address as "the identity" would have welded all three together,
-- and the first time somebody moved wallets their agent would have looked like
-- a different agent: same memory, same history, same Arc attestations, new
-- identity. Owner is the field that changes; the pair is the field that does
-- not.
--
-- `arc_identity_address` is left in place and unused rather than dropped. It
-- has never been written -- no agent has an identity yet -- and a column that
-- costs nothing is a smaller risk than a destructive change, but it must not
-- be read: the comment says so, because the next person to find it will
-- otherwise assume it means what its name says.

ALTER TABLE public.nova_agents
    ADD COLUMN IF NOT EXISTS arc_identity_registry TEXT,
    ADD COLUMN IF NOT EXISTS arc_identity_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS arc_identity_owner TEXT,
    ADD COLUMN IF NOT EXISTS arc_identity_chain_id INTEGER,
    ADD COLUMN IF NOT EXISTS arc_identity_tx TEXT;

COMMENT ON COLUMN public.nova_agents.arc_identity_address IS
    'DEPRECATED and never written. An ERC-8004 identity is (arc_identity_registry, arc_identity_agent_id); the owner is arc_identity_owner and may change without the identity changing. Do not read this column.';
COMMENT ON COLUMN public.nova_agents.arc_identity_registry IS
    'ERC-8004 IdentityRegistry this agent is registered in, as a checksummed address on arc_identity_chain_id.';
COMMENT ON COLUMN public.nova_agents.arc_identity_agent_id IS
    'The ERC-721 tokenId minted for this agent. Together with the registry it is the agent identity, and neither changes when the owner does.';
COMMENT ON COLUMN public.nova_agents.arc_identity_owner IS
    'Address holding the identity NFT, verified against ownerOf() at registration. Expected to change over time; the agent does not.';
