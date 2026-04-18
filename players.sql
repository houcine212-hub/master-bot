-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Hôte : 127.0.0.1
-- Généré le : mar. 14 avr. 2026 à 18:44
-- Version du serveur : 10.4.32-MariaDB
-- Version de PHP : 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Base de données : `master_game`
--

-- --------------------------------------------------------

--
-- Structure de la table `players`
--

CREATE TABLE `players` (
  `id` int(11) NOT NULL,
  `player_id_public` varchar(8) NOT NULL,
  `telegram_id` varchar(255) DEFAULT NULL,
  `name` varchar(50) NOT NULL,
  `character_name` varchar(50) NOT NULL,
  `hp` int(11) DEFAULT 5000,
  `atk` int(11) DEFAULT 100,
  `def` int(11) DEFAULT 50,
  `spd` int(11) DEFAULT 10,
  `acc` int(11) DEFAULT 10,
  `mag` int(11) DEFAULT 100,
  `sta` int(11) DEFAULT 100,
  `level` int(11) DEFAULT 1,
  `xp` int(11) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Déchargement des données de la table `players`
--

INSERT INTO `players` (`id`, `player_id_public`, `telegram_id`, `name`, `character_name`, `hp`, `atk`, `def`, `spd`, `acc`, `mag`, `sta`, `level`, `xp`, `created_at`) VALUES
(2, '12345678', '1646jk53jk', 'player2', 'luffy', 5000, 100, 50, 10, 10, 100, 100, 1, 0, '2026-04-14 14:36:41'),
(12, '94EAB3C2', '6058321388', 'houcine', 'goku', 5000, 100, 50, 10, 10, 100, 100, 1, 0, '2026-04-13 15:45:39'),
(13, '39C6C83F', '-1003537518095', 'grthg', 'th', 5000, 100, 50, 10, 10, 100, 100, 1, 0, '2026-04-14 14:40:34');

--
-- Index pour les tables déchargées
--

--
-- Index pour la table `players`
--
ALTER TABLE `players`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `player_id_public` (`player_id_public`),
  ADD UNIQUE KEY `telegram_id` (`telegram_id`);

--
-- AUTO_INCREMENT pour les tables déchargées
--

--
-- AUTO_INCREMENT pour la table `players`
--
ALTER TABLE `players`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=14;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
